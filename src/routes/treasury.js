'use strict';
/* Treasury and risk reports — capital deployment, P&L and portfolio risk.
   Everything is computed as at a date from the dated entries and the loan book;
   nothing here is a stored figure that could go stale. */
const express = require('express');
const { q } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const audit = require('../audit');
const book = require('../book');
const policy = require('../policy');
const settings = require('../settings');
const { H, bad, notFound, optStr, reqNum, reqDate, optDate, oneOf, reqId } = require('../http');

const router = express.Router();
const day = (v) => (v == null ? null : String(v).slice(0, 10));
const money = calc.money;
const SOURCES = ['Director infusion', 'Equity', 'Bank line', 'NBFC line', 'NCD', 'Inter-corporate deposit', 'Other'];
const BUCKETS = ['Fixed deposit', 'Liquid fund', 'Current account', 'Other'];

/* ============================================================================
   Capital deployment
   ========================================================================== */
const monthEnd = (ym) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)); return d.toISOString().slice(0, 10); };
const nextMonth = (ym) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 1)); return d.toISOString().slice(0, 7); };

function position(date, funding, parked, store) {
  // capital raised, net = entries in less entries out, up to the date
  const entries = funding.filter((f) => f.date <= date);
  const funds = money(entries.reduce((s, f) => s + (f.direction === 'out' ? -f.amount : f.amount), 0));
  // blended cost over interest-bearing money only — nil-rate director capital would flatter the average
  const bearing = entries.filter((f) => f.direction === 'in' && f.rate > 0);
  const bearingTotal = bearing.reduce((s, f) => s + f.amount, 0);
  const cost = bearingTotal > 0 ? +(bearing.reduce((s, f) => s + f.amount * f.rate, 0) / bearingTotal).toFixed(2) : 0;

  // parked: the latest snapshot per bucket on or before the date (an entry SETS the bucket)
  const latest = {};
  parked.filter((p) => p.asOf <= date).forEach((p) => {
    const cur = latest[p.bucket];
    if (!cur || p.asOf > cur.asOf || (p.asOf === cur.asOf && p.id > cur.id)) latest[p.bucket] = p;
  });
  const parkedBy = {};
  Object.values(latest).forEach((p) => { if (p.balance > 0) parkedBy[p.bucket] = money(p.balance); });
  const parkedTotal = money(Object.values(parkedBy).reduce((s, v) => s + v, 0));

  // lent out: principal not yet repaid, for every drawdown debited on or before the date
  let loans = 0;
  store.drawdowns.filter((d) => d.bankDebit <= date).forEach((d) => {
    const repaid = store.payments.filter((p) => p.drawdownId === d.id && p.date <= date).reduce((s, p) => s + (+p.prinAdj || 0), 0);
    loans += Math.max(0, (+d.poAmt || 0) - repaid);
  });
  loans = money(loans);

  const idle = money(Math.max(0, funds - loans - parkedTotal));
  return { funds, loans, parked: parkedTotal, idle, cost, utilPct: funds > 0 ? +(loans / funds * 100).toFixed(1) : null, parkedBy };
}

router.get('/capital', H(async (req) => {
  auth.requireUser(req);
  const [fRows, pRows, store] = await Promise.all([
    q('SELECT * FROM capital_funding ORDER BY entry_date DESC, id DESC'),
    q('SELECT * FROM capital_parked ORDER BY as_of DESC, id DESC'),
    repo.loadEngineStore()
  ]);
  const funding = fRows.map((f) => ({ id: f.id, date: day(f.entry_date), source: f.source, counterparty: f.counterparty, direction: f.direction,
    amount: +f.amount, rate: +f.rate, maturity: day(f.maturity), remarks: f.remarks }));
  const parked = pRows.map((p) => ({ id: p.id, asOf: day(p.as_of), bucket: p.bucket, label: p.label, balance: +p.balance, note: p.note }));

  const today = calc.td();
  const now = position(today, funding, parked, store);
  const series = [];
  if (funding.length) {
    let ym = funding.map((f) => f.date).sort()[0].slice(0, 7);
    const last = today.slice(0, 7);
    for (let i = 0; ym <= last && i < 120; i++, ym = nextMonth(ym)) {
      const at = ym === last ? today : monthEnd(ym);
      const p = position(at, funding, parked, store);
      series.push({ month: ym, funds: p.funds, loans: p.loans, parked: p.parked, idle: p.idle, utilPct: p.utilPct });
    }
  }
  return { now, series: series.slice(-36).reverse(), funding, parked, catalogue: { sources: SOURCES, buckets: BUCKETS } };
}));

router.post('/capital/funding', H(async (req) => {
  const me = auth.requireDirector(req);
  const b = req.body || {};
  const f = {
    date: reqDate(b.date || calc.td(), 'Value date'), source: oneOf(b.source, 'Source', SOURCES),
    counterparty: optStr(b.counterparty, 'Counterparty', { max: 190 }), direction: oneOf(b.direction, 'Direction', ['in', 'out'], 'in'),
    amount: reqNum(b.amount, 'Amount', { positive: true, max: 1e14 }),
    rate: reqNum(b.rate == null || b.rate === '' ? 0 : b.rate, 'Rate', { min: 0, max: 100 }),
    maturity: optDate(b.maturity, 'Maturity'), remarks: optStr(b.remarks, 'Remarks', { max: 255 })
  };
  const r = await q(`INSERT INTO capital_funding (entry_date, source, counterparty, direction, amount, rate, maturity, remarks, created_by)
                     VALUES (?,?,?,?,?,?,?,?,?)`, [f.date, f.source, f.counterparty, f.direction, f.amount, f.rate, f.maturity, f.remarks, me.name]);
  await audit.log(req, 'capital.funding', 'capital', r.insertId,
    me.name + ' recorded ' + policy.inrShort(f.amount) + ' ' + f.direction + ' from ' + f.source + (f.counterparty ? ' (' + f.counterparty + ')' : ''), f);
  return { id: r.insertId };
}));

router.delete('/capital/funding/:id', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Entry');
  const [row] = await q('SELECT * FROM capital_funding WHERE id = ?', [id]);
  if (!row) throw notFound('Funding entry not found.');
  await q('DELETE FROM capital_funding WHERE id = ?', [id]);
  await audit.log(req, 'capital.funding.delete', 'capital', id, me.name + ' removed a ' + policy.inrShort(+row.amount) + ' ' + row.source + ' entry');
  return { ok: true };
}));

router.post('/capital/parked', H(async (req) => {
  const me = auth.requireDirector(req);
  const b = req.body || {};
  const p = {
    asOf: reqDate(b.asOf || calc.td(), 'As at'), bucket: oneOf(b.bucket, 'Bucket', BUCKETS),
    label: optStr(b.label, 'Label', { max: 190 }), balance: reqNum(b.balance, 'Balance', { min: 0, max: 1e14 }),
    note: optStr(b.note, 'Note', { max: 255 })
  };
  const r = await q('INSERT INTO capital_parked (as_of, bucket, label, balance, note, created_by) VALUES (?,?,?,?,?,?)',
    [p.asOf, p.bucket, p.label, p.balance, p.note, me.name]);
  await audit.log(req, 'capital.parked', 'capital', r.insertId, me.name + ' set ' + p.bucket + ' to ' + policy.inrShort(p.balance) + ' as at ' + p.asOf, p);
  return { id: r.insertId };
}));

router.delete('/capital/parked/:id', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Entry');
  const [row] = await q('SELECT * FROM capital_parked WHERE id = ?', [id]);
  if (!row) throw notFound('Parked balance not found.');
  await q('DELETE FROM capital_parked WHERE id = ?', [id]);
  await audit.log(req, 'capital.parked.delete', 'capital', id, me.name + ' removed a parked-balance entry for ' + row.bucket);
  return { ok: true };
}));

/* ============================================================================
   P&L — cash basis; GST is never income
   ========================================================================== */
router.get('/pnl', H(async (req) => {
  auth.requireUser(req);
  const t = calc.td();
  const fy = (new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1) + '-04-01';
  const from = optDate(req.query.from, 'From date', fy);
  const to = optDate(req.query.to, 'To date', t);
  if (from > to) throw bad('The window starts after it ends.');

  const store = await repo.loadEngineStore();
  const dds = store.drawdowns.filter((d) => d.bankDebit >= from && d.bankDebit <= to);
  const pays = store.payments.filter((p) => p.date >= from && p.date <= to);
  const sum = (a, k) => money(a.reduce((s, x) => s + (+x[k] || 0), 0));

  const months = {};
  const bucket = (m) => (months[m] = months[m] || { month: m, processingFees: 0, advanceInterest: 0, interestCollected: 0, gst: 0 });
  dds.forEach((d) => { const m = bucket(d.bankDebit.slice(0, 7)); m.processingFees += +d.fee || 0; m.advanceInterest += +d.adv || 0; m.gst += +d.gstAmt || 0; });
  pays.forEach((p) => { bucket(p.date.slice(0, 7)).interestCollected += +p.intAdj || 0; });
  const monthly = Object.values(months).sort((a, b) => (a.month < b.month ? -1 : 1)).map((m) => ({
    month: m.month, processingFees: money(m.processingFees), advanceInterest: money(m.advanceInterest),
    interestCollected: money(m.interestCollected), gst: money(m.gst),
    total: money(m.processingFees + m.advanceInterest + m.interestCollected)
  }));

  const lines = [
    { label: 'Processing fees (net of GST)', note: 'Taken at disbursal — recognised on the drawdown date', amount: sum(dds, 'fee') },
    { label: 'Advance interest', note: 'Deducted upfront on the drawdown — recognised on the same date', amount: sum(dds, 'adv') },
    { label: 'Interest collected', note: 'The interest portion of each receipt — recognised when the money arrives', amount: sum(pays, 'intAdj') }
  ];
  return {
    from, to, lines, monthly, totalIncome: money(lines.reduce((s, l) => s + l.amount, 0)), gstCollected: sum(dds, 'gstAmt'),
    principalDisbursed: sum(dds, 'poAmt'), disbursedCount: dds.length, principalRepaid: sum(pays, 'prinAdj'), receiptCount: pays.length,
    accruedUnbilled: calc.portfolio(store).accruedOpen
  };
}));

/* ============================================================================
   Portfolio & risk
   ========================================================================== */
router.get('/risk', H(async (req) => {
  auth.requireUser(req);
  const [ctx, pol] = await Promise.all([book.liveBook(), settings.getPolicy()]);
  const { store, byBorrower } = ctx;
  const today = calc.td();
  const total = ctx.liveBook;
  const share = (n) => (total > 0 ? +(n / total * 100).toFixed(1) : 0);
  const bById = new Map(store.borrowers.map((b) => [b.id, b]));
  const open = store.drawdowns.filter((d) => d.status !== 'Repaid');

  const cls = Object.fromEntries(calc.SMA_KEYS.map((k) => [k, { key: k, label: k, count: 0, outstanding: 0 }]));
  const mix = {};
  open.forEach((d) => {
    const b = bById.get(d.borrowerId);
    const bucket = d.loanType === 'io' ? 'Standard' : calc.smaBucket(calc.poAccrued(d, b, today).odD);
    cls[bucket].count++; cls[bucket].outstanding += +d.outPrin || 0;
    const key = (b && b.product) || 'legacy';
    const m = mix[key] = mix[key] || { key, label: key === 'legacy' ? 'Legacy PO / IO book' : policy.PRODUCTS[key].name, count: 0, outstanding: 0 };
    m.count++; m.outstanding += +d.outPrin || 0;
  });
  const classification = calc.SMA_KEYS.map((k) => ({ ...cls[k], outstanding: money(cls[k].outstanding), share: share(cls[k].outstanding) }));
  const npa = cls.NPA.outstanding;

  const topExposures = [...byBorrower.entries()].filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([id, v]) => ({ borrowerId: id, name: bById.get(id).name, outstanding: money(v), share: share(v) }));

  const nof = +pol.nof || 0;
  const cap = nof * 0.05;
  const vcRows = Object.entries(ctx.vcExposure).filter(([, v]) => v > 0.5).map(([vc, v]) => {
    const pct = share(v);
    return { vc, borrowers: ctx.vcBorrowers[vc] || [], exposure: money(v), pct,
      band: pct > pol.vcCapMaxPct ? 'hard' : pct > pol.vcCapWarnPct ? 'deviation' : 'ok' };
  }).sort((a, b) => b.pct - a.pct);

  return {
    asOf: today, totalOutstanding: total, npaRatio: total > 0 ? +(npa / total * 100).toFixed(2) : 0,
    classification,
    productMix: Object.values(mix).map((m) => ({ ...m, outstanding: money(m.outstanding), share: share(m.outstanding) })).sort((a, b) => b.outstanding - a.outstanding),
    topExposures, ageing: calc.ageing(store, today),
    caps: {
      bullet: { pct: share(ctx.bulletOutstanding), limitPct: 25, outstanding: ctx.bulletOutstanding },
      singleBorrower: {
        limitPct: 5, active: nof > 0, cap: money(cap),
        breaches: nof > 0 ? [...byBorrower.entries()].filter(([, v]) => v > cap).map(([id, v]) => ({ borrowerId: id, name: bById.get(id).name, outstanding: money(v) })) : []
      }
    },
    vcConcentration: { active: total >= pol.vcCapMinBook, warnPct: pol.vcCapWarnPct, maxPct: pol.vcCapMaxPct, minBook: pol.vcCapMinBook, rows: vcRows }
  };
}));

module.exports = router;
