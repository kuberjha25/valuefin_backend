'use strict';
/* Read-only derivations: the consolidated ledger, per-borrower MIS, the
   portfolio rollup behind the dashboard, and global search. */
const express = require('express');
const { q } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const { H, notFound, optDate, oneOf, reqId, optId } = require('../http');

const router = express.Router();

/* ---------------- ledger ---------------- */
router.get('/ledger', H(async (req) => {
  auth.requireUser(req);
  const borrowerId = optId(req.query.borrowerId, 'Borrower');
  const store = await repo.loadEngineStore(borrowerId ? { borrowerId } : {});
  const rows = calc.buildLedger(store, {
    borrowerId,
    from: optDate(req.query.from, 'From date'),
    to: optDate(req.query.to, 'To date'),
    type: req.query.type
  });
  const totals = rows.reduce((t, e) => {
    if (e.dir === 'out') t.out += e.amount; else t.in += e.amount;
    t.fee += e.fee || 0; t.gst += e.gst || 0; t.adv += e.adv || 0;
    t.interest += e.intAdj || 0; t.principal += e.prinAdj || 0;
    return t;
  }, { out: 0, in: 0, fee: 0, gst: 0, adv: 0, interest: 0, principal: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = calc.money(totals[k]); });
  return { rows, totals, count: rows.length };
}));

/* ---------------- MIS ---------------- */
router.get('/mis/:borrowerId', H(async (req) => {
  auth.requireUser(req);
  const bid = reqId(req.params.borrowerId, 'Borrower');
  const store = await repo.loadEngineStore({ borrowerId: bid });
  if (!store.borrowers.length) throw notFound('Borrower not found.');
  const asOf = optDate(req.query.to, 'To date', calc.td());

  return {
    summary: calc.borrowerSummary(store, bid, asOf),
    statement: calc.buildLedger(store, {
      borrowerId: bid, from: optDate(req.query.from, 'From date'), to: optDate(req.query.to, 'To date')
    }),
    drawdowns: store.drawdowns
      .map((d) => calc.decorateDrawdown(d, store.borrowers[0], store.payments, asOf))
      .sort((a, c) => (a.bankDebit < c.bankDebit ? 1 : -1)),
    limitHistory: store.limitHistory.slice().sort((a, c) => (a.date < c.date ? 1 : -1)),
    monthly: calc.monthlySeries(store, 6),
    generatedAt: new Date().toISOString()
  };
}));

/* ---------------- portfolio / dashboard ---------------- */
router.get('/portfolio', H(async (req) => {
  auth.requireUser(req);
  const store = await repo.loadEngineStore();
  const p = calc.portfolio(store);

  const alerts = [];
  store.borrowers.forEach((b) => {
    const r = calc.renewalStatus(store, b.id);
    if (r && r.status === 'overdue') {
      alerts.push({ sev: 'high', kind: 'renewal', borrowerId: b.id, text: b.name + ' facility renewal is overdue (was due ' + r.renewDate + ')' });
    } else if (r && r.status === 'warn') {
      alerts.push({ sev: 'med', kind: 'renewal', borrowerId: b.id, text: b.name + ' facility renewal is due in ' + r.daysLeft + ' days (' + r.renewDate + ')' });
    }
    store.drawdowns.filter((d) => d.borrowerId === b.id && d.status !== 'Repaid').forEach((d) => {
      const odD = d.loanType === 'io' ? 0 : calc.poAccrued(d, b, calc.td()).odD;
      if (odD > 0) {
        alerts.push({ sev: 'high', kind: 'overdue', borrowerId: b.id,
          text: b.name + ' · ' + (d.ref || 'drawdown #' + d.id) + ' is ' + odD + ' day(s) overdue (₹' + Math.round(d.outPrin).toLocaleString('en-IN') + ')' });
      } else {
        const daysLeft = calc.di(calc.td(), calc.dueDate(d, b)) - 1;
        if (daysLeft >= 0 && daysLeft <= 7) {
          alerts.push({ sev: 'med', kind: 'maturity', borrowerId: b.id,
            text: b.name + ' · ' + (d.ref || 'drawdown #' + d.id) + ' matures in ' + daysLeft + ' day(s)' });
        }
      }
    });
    const util = calc.borrowerSummary(store, b.id).utilPct;
    if (util >= 95) alerts.push({ sev: 'med', kind: 'utilisation', borrowerId: b.id, text: b.name + ' is at ' + util + '% of its sanctioned limit' });
  });

  const [{ pending }] = await q("SELECT COUNT(*) AS pending FROM documents WHERE status = 'pending'");
  if (pending > 0) alerts.push({ sev: 'med', kind: 'documents', text: pending + ' document(s) awaiting Director review' });

  const order = { high: 0, med: 1 };
  alerts.sort((a, b) => (order[a.sev] - order[b.sev]));

  return Object.assign(p, {
    alerts,
    pendingDocuments: +pending,
    monthly: calc.monthlySeries(store, 6),
    ageing: calc.ageing(store),
    ledger: calc.buildLedger(store).slice(-10).reverse()
  });
}));

/* ---------------- global search (command palette) ---------------- */
router.get('/search', H(async (req) => {
  auth.requireUser(req);
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return { borrowers: [], drawdowns: [], documents: [] };
  const like = '%' + term + '%';

  const [borrowers, drawdowns, documents] = await Promise.all([
    q('SELECT id, name, biz, slug FROM borrowers WHERE name LIKE ? OR biz LIKE ? ORDER BY name LIMIT 8', [like, like]),
    q(`SELECT d.id, d.ref, d.po_amt, d.status, d.borrower_id, b.name AS borrower_name
         FROM drawdowns d JOIN borrowers b ON b.id = d.borrower_id
        WHERE d.ref LIKE ? ORDER BY d.bank_debit DESC LIMIT 8`, [like]),
    q(`SELECT d.id, d.title, d.status, d.borrower_id, b.name AS borrower_name
         FROM documents d JOIN borrowers b ON b.id = d.borrower_id
        WHERE d.title LIKE ? OR d.filename LIKE ? ORDER BY d.id DESC LIMIT 8`, [like, like])
  ]);

  return {
    borrowers: borrowers.map((r) => ({ id: r.id, name: r.name, biz: r.biz, slug: r.slug })),
    drawdowns: drawdowns.map((r) => ({ id: r.id, ref: r.ref, amount: +r.po_amt, status: r.status, borrowerId: r.borrower_id, borrowerName: r.borrower_name })),
    documents: documents.map((r) => ({ id: r.id, title: r.title, status: r.status, borrowerId: r.borrower_id, borrowerName: r.borrower_name }))
  };
}));

/* ---------------- audit trail ---------------- */
router.get('/audit', H(async (req) => {
  auth.requireUser(req);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const filters = [], args = [];
  if (req.query.entity) { filters.push('entity = ?'); args.push(String(req.query.entity)); }
  if (req.query.userId) { filters.push('user_id = ?'); args.push(reqId(req.query.userId, 'User')); }
  if (req.query.action) { filters.push('action LIKE ?'); args.push(String(req.query.action) + '%'); }
  const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
  const rows = await q('SELECT * FROM audit_log' + where + ' ORDER BY id DESC LIMIT ' + limit, args);
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM audit_log' + where, args);
  return { rows: rows.map(repo.mapAudit), total: +n, limit };
}));

module.exports = router;
