'use strict';
/* Borrowers — the facility record, its summary, and sanctioned-limit history. */
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { q, tx } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const audit = require('../audit');
const docstore = require('../docstore');
const { notify } = require('../notify');
const { CHECKLIST_ITEMS, CHECKLIST_KEYS } = require('../checklist');
const { H, bad, notFound, reqStr, optStr, reqNum, optNum, reqDate, optDate, oneOf, reqId } = require('../http');

const router = express.Router();

/* ---------------- list ---------------- */
router.get('/', H(async (req) => {
  auth.requireUser(req);
  const store = await repo.loadEngineStore();
  let rows = store.borrowers.map((b) => calc.borrowerSummary(store, b.id));

  const search = String(req.query.q || '').trim().toLowerCase();
  if (search) rows = rows.filter((r) => (r.name + ' ' + (r.biz || '')).toLowerCase().includes(search));
  if (req.query.loanType) rows = rows.filter((r) => r.loanType === req.query.loanType);
  if (req.query.state === 'open') rows = rows.filter((r) => r.outstanding > 0);
  if (req.query.state === 'overdue') rows = rows.filter((r) => r.overdueDays > 0);
  if (req.query.state === 'idle') rows = rows.filter((r) => r.outstanding === 0);

  const sort = String(req.query.sort || 'outstanding');
  const dir = req.query.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = a[sort], vb = b[sort];
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return ((va || 0) - (vb || 0)) * dir;
  });
  return rows;
}));

/* ---------------- detail ---------------- */
router.get('/:id', H(async (req) => {
  auth.requireUser(req);
  const id = reqId(req.params.id, 'Borrower');
  const store = await repo.loadEngineStore({ borrowerId: id });
  const b = store.borrowers[0];
  if (!b) throw notFound('Borrower not found.');

  const docs = await q(repo.DOCUMENT_SELECT + ' WHERE d.borrower_id = ? ORDER BY d.id DESC', [id]);

  return {
    borrower: b,
    summary: calc.borrowerSummary(store, id),
    drawdowns: store.drawdowns
      .map((d) => calc.decorateDrawdown(d, b, store.payments))
      .sort((a, c) => (a.bankDebit === c.bankDebit ? c.id - a.id : (a.bankDebit < c.bankDebit ? 1 : -1))),
    payments: store.payments.slice().sort((a, c) => (a.date === c.date ? c.id - a.id : (a.date < c.date ? 1 : -1))),
    limitHistory: store.limitHistory.slice().sort((a, c) => (a.date < c.date ? 1 : -1)),
    documents: docs.map(repo.mapDocument),
    ledger: calc.buildLedger(store, { borrowerId: id })
  };
}));

/* ---------------- create ---------------- */
function readFacility(body, { partial = false } = {}) {
  const pick = (v, fn, fallback) => (partial && (v == null || v === '') ? undefined : fn());
  return {
    name: pick(body.name, () => reqStr(body.name, 'Borrower name')),
    biz: body.biz == null ? undefined : optStr(body.biz, 'Business / sector'),
    loanType: body.loanType == null ? undefined : oneOf(body.loanType, 'Product', ['po', 'io']),
    limit: pick(body.limit, () => reqNum(body.limit, 'Sanctioned limit', { min: 0, max: 1e13 })),
    rate: body.rate == null ? undefined : reqNum(body.rate, 'Interest rate', { min: 0, max: 100 }),
    penRate: body.penRate == null ? undefined : reqNum(body.penRate, 'Penal charge', { min: 0, max: 100 }),
    procFeePct: body.procFeePct == null ? undefined : reqNum(body.procFeePct, 'Processing fee', { min: 0, max: 100 }),
    gstPct: body.gstPct == null ? undefined : reqNum(body.gstPct, 'GST', { min: 0, max: 100 }),
    tenure: body.tenure == null ? undefined : reqNum(body.tenure, 'Tenure', { min: 1, max: 3650 }),
    tenureUnit: body.tenureUnit == null ? undefined : oneOf(body.tenureUnit, 'Tenure unit', ['days', 'months']),
    sanctionDate: pick(body.sanctionDate, () => reqDate(body.sanctionDate, 'Sanction date')),
    contactName: body.contactName == null ? undefined : optStr(body.contactName, 'Contact name', { max: 120 }),
    contactEmail: body.contactEmail == null ? undefined : optStr(body.contactEmail, 'Contact email'),
    contactPhone: body.contactPhone == null ? undefined : optStr(body.contactPhone, 'Contact phone', { max: 40 }),
    pan: body.pan == null ? undefined : optStr(body.pan, 'PAN', { max: 20 }).toUpperCase(),
    gstin: body.gstin == null ? undefined : optStr(body.gstin, 'GSTIN', { max: 24 }).toUpperCase(),
    status: body.status == null ? undefined : oneOf(body.status, 'Status', ['active', 'closed'])
  };
}

/* Onboarding is multipart: the facility fields plus one mandatory PDF. A
   borrower may not exist on this book without at least one document on file,
   so the row and the document are written in a single transaction — if either
   half fails, neither is kept. */
router.post('/', docstore.upload.single('file'), H(async (req) => {
  const me = auth.requireWrite(req);
  const f = readFacility(req.body);

  if (!req.file) {
    throw bad('An onboarding document is required — attach the sanction letter, KYC or equivalent PDF.');
  }
  docstore.assertPdf(req.file);
  const docCategory = oneOf(req.body.docCategory, 'Document category', docstore.CATEGORIES, 'KYC');
  const docChecklistKey = req.body.docChecklistKey ? oneOf(req.body.docChecklistKey, 'Checklist item', CHECKLIST_KEYS) : null;
  const docTitle = optStr(req.body.docTitle, 'Document title') || req.file.originalname.replace(/\.pdf$/i, '');

  const dupe = await q('SELECT id FROM borrowers WHERE name = ? LIMIT 1', [f.name]);
  if (dupe.length) throw bad('A borrower named “' + f.name + '” already exists.');
  const slug = await repo.uniqueSlug(f.name);

  let written = null;
  let result;
  try {
    result = await tx(async (cx) => {
      const r = await cx.q(
        `INSERT INTO borrowers (slug, name, biz, loan_type, base_limit, rate, pen_rate, proc_fee_pct, gst_pct,
                                tenure, tenure_unit, sanction_date, contact_name, contact_email, contact_phone,
                                pan, gstin, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [slug, f.name, f.biz || '', f.loanType || 'po', f.limit, f.rate ?? 18, f.penRate ?? 6,
          f.procFeePct ?? 1.5, f.gstPct ?? 18, f.tenure ?? 90, f.tenureUnit || 'days', f.sanctionDate,
          f.contactName || '', f.contactEmail || '', f.contactPhone || '', f.pan || '', f.gstin || '', me.name]
      );
      const borrower = { id: r.insertId, slug };
      const doc = await docstore.saveDocument(cx.q, {
        borrower, file: req.file, title: docTitle, category: docCategory, checklistKey: docChecklistKey, user: me
      });
      written = doc.abs;
      return { borrowerId: r.insertId, doc };
    });
  } catch (e) {
    docstore.discardFile(written);       // the row is gone; the file must go too
    throw e;
  }

  await notify({ toRole: 'director', type: 'upload', docId: result.doc.id, borrowerId: result.borrowerId,
    customerName: f.name,
    message: me.name + ' onboarded ' + f.name + ' and filed “' + docTitle + '” — awaiting your review.' });
  await audit.log(req, 'borrower.create', 'borrower', result.borrowerId,
    me.name + ' onboarded ' + f.name + ' with “' + docTitle + '”',
    { limit: f.limit, rate: f.rate, loanType: f.loanType, documentId: result.doc.id, docCategory, docChecklistKey });

  const store = await repo.loadEngineStore({ borrowerId: result.borrowerId });
  return Object.assign(calc.borrowerSummary(store, result.borrowerId), { document: await repo.getDocument(result.doc.id) });
}));

/* ---------------- update ---------------- */
const COLS = {
  name: 'name', biz: 'biz', loanType: 'loan_type', limit: 'base_limit', rate: 'rate', penRate: 'pen_rate',
  procFeePct: 'proc_fee_pct', gstPct: 'gst_pct', tenure: 'tenure', tenureUnit: 'tenure_unit',
  sanctionDate: 'sanction_date', contactName: 'contact_name', contactEmail: 'contact_email',
  contactPhone: 'contact_phone', pan: 'pan', gstin: 'gstin', status: 'status'
};

router.put('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Borrower');
  const before = await repo.getBorrower(id);
  if (!before) throw notFound('Borrower not found.');

  const f = readFacility(req.body, { partial: true });
  const sets = [], args = [], changed = {};
  Object.entries(COLS).forEach(([key, col]) => {
    if (f[key] === undefined) return;
    if (String(before[key]) === String(f[key])) return;
    sets.push('`' + col + '` = ?'); args.push(f[key]); changed[key] = { from: before[key], to: f[key] };
  });
  if (f.name && f.name !== before.name) {
    const dupe = await q('SELECT id FROM borrowers WHERE name = ? AND id <> ? LIMIT 1', [f.name, id]);
    if (dupe.length) throw bad('Another borrower already uses that name.');
  }
  if (!sets.length) {
    const store0 = await repo.loadEngineStore({ borrowerId: id });
    return calc.borrowerSummary(store0, id);
  }

  args.push(id);
  await q('UPDATE borrowers SET ' + sets.join(', ') + ' WHERE id = ?', args);

  // Rate/tenure changes re-price every open drawdown's accrual, so re-derive
  // each drawdown from its own payment history rather than leaving stale state.
  if (changed.rate || changed.penRate || changed.tenure || changed.tenureUnit || changed.loanType) {
    await rebuildBorrower(id);
  }
  await audit.log(req, 'borrower.update', 'borrower', id, me.name + ' updated ' + before.name, changed);

  const store = await repo.loadEngineStore({ borrowerId: id });
  return calc.borrowerSummary(store, id);
}));

/* Re-derive every drawdown of a borrower from its payment history. */
async function rebuildBorrower(borrowerId) {
  const store = await repo.loadEngineStore({ borrowerId });
  const b = store.borrowers[0];
  if (!b) return;
  await tx(async (cx) => {
    for (const d of store.drawdowns) {
      const pays = store.payments.filter((p) => p.drawdownId === d.id);
      await repo.persistReplay(cx, d.id, calc.replayDrawdown(d, b, pays));
    }
  });
}

/* ---------------- delete ---------------- */
router.delete('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Borrower');
  const b = await repo.getBorrower(id);
  if (!b) throw notFound('Borrower not found.');

  const [{ n }] = await q(
    'SELECT (SELECT COUNT(*) FROM drawdowns WHERE borrower_id = ?) + (SELECT COUNT(*) FROM payments WHERE borrower_id = ?) AS n',
    [id, id]);
  // Wiping a facility that has money history is a Director decision.
  if (n > 0 && me.role !== 'director') {
    throw Object.assign(new Error('This borrower has ' + n + ' financial record(s). Only the Director can delete it.'), { status: 403 });
  }

  const [{ docs }] = await q('SELECT COUNT(*) AS docs FROM documents WHERE borrower_id = ?', [id]);
  await q('DELETE FROM borrowers WHERE id = ?', [id]);   // cascades to the child tables

  /* The cascade clears the document rows but not the PDFs they pointed at, so
     remove the borrower's folder too — otherwise every deletion orphans files
     on disk. Confined to the customers directory in case a slug is ever odd. */
  try {
    const folder = path.resolve(config.paths.customers, b.slug);
    if (folder.startsWith(path.resolve(config.paths.customers) + path.sep) && fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  } catch (e) { console.error('[borrowers] could not remove document folder:', e.message); }

  await audit.log(req, 'borrower.delete', 'borrower', id,
    me.name + ' deleted ' + b.name + ' (' + n + ' financial records, ' + docs + ' document(s))');
  return { ok: true };
}));

/* ---------------- onboarding document checklist ----------------
   Independent of whatever status/search filter the Documents page has
   applied — always reflects every document ever filed against this borrower,
   so "missing" really means missing. */
router.get('/:id/checklist', H(async (req) => {
  auth.requireUser(req);
  const id = reqId(req.params.id, 'Borrower');
  const b = await repo.getBorrower(id);
  if (!b) throw notFound('Borrower not found.');

  const rows = await q(
    `SELECT id, title, checklist_key, status FROM documents
      WHERE borrower_id = ? AND checklist_key IS NOT NULL`, [id]);

  const rank = { approved: 3, pending: 2, rejected: 1 };
  const best = {};
  for (const r of rows) {
    const cur = best[r.checklist_key];
    if (!cur || rank[r.status] > rank[cur.status]) best[r.checklist_key] = r;
  }

  return CHECKLIST_ITEMS.map((it) => {
    const hit = best[it.key];
    return {
      key: it.key, label: it.label, group: it.group,
      status: hit ? hit.status : 'missing',
      document: hit ? { id: hit.id, title: hit.title } : null
    };
  });
}));

/* ---------------- sanctioned-limit enhancements ---------------- */
router.get('/:id/limit-history', H(async (req) => {
  auth.requireUser(req);
  const id = reqId(req.params.id, 'Borrower');
  const rows = await q('SELECT * FROM limit_history WHERE borrower_id = ? ORDER BY event_date DESC, id DESC', [id]);
  return rows.map(repo.mapLimit);
}));

router.post('/:id/limit', H(async (req) => {
  const me = auth.requireDirector(req);   // a credit decision, not an ops entry
  const id = reqId(req.params.id, 'Borrower');
  const b = await repo.getBorrower(id);
  if (!b) throw notFound('Borrower not found.');

  const incrAmt = reqNum(req.body.incrAmt, 'Enhancement amount', { max: 1e13 });
  if (incrAmt === 0) throw bad('Enter a non-zero enhancement (use a negative amount to reduce the limit).');
  const date = optDate(req.body.date, 'Effective date', calc.td());
  const note = optStr(req.body.note, 'Note', { max: 255 });

  const store = await repo.loadEngineStore({ borrowerId: id });
  const summary = calc.borrowerSummary(store, id);
  if (summary.limit + incrAmt < summary.outstanding) {
    throw bad('That would drop the limit to ' + Math.round(summary.limit + incrAmt) +
      ', below the current outstanding of ' + Math.round(summary.outstanding) + '.');
  }

  const r = await q(
    'INSERT INTO limit_history (borrower_id, event_date, incr_amt, note, created_by) VALUES (?,?,?,?,?)',
    [id, date, incrAmt, note, me.name]);
  await audit.log(req, 'borrower.limit', 'borrower', id,
    me.name + (incrAmt > 0 ? ' enhanced ' : ' reduced ') + b.name + "'s limit by " + Math.abs(incrAmt), { incrAmt, date, note });
  await notify({ toRole: 'manager', type: 'limit', borrowerId: id, customerName: b.name,
    message: b.name + "'s sanctioned limit was " + (incrAmt > 0 ? 'increased' : 'reduced') + ' by ₹' + Math.abs(Math.round(incrAmt)).toLocaleString('en-IN') + ' by ' + me.name + '.' });

  const after = await repo.loadEngineStore({ borrowerId: id });
  return { entry: repo.mapLimit((await q('SELECT * FROM limit_history WHERE id = ?', [r.insertId]))[0]),
    summary: calc.borrowerSummary(after, id) };
}));

router.delete('/:id/limit/:limitId', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Borrower');
  const limitId = reqId(req.params.limitId, 'Limit entry');
  const rows = await q('SELECT * FROM limit_history WHERE id = ? AND borrower_id = ?', [limitId, id]);
  if (!rows.length) throw notFound('Limit entry not found.');

  const store = await repo.loadEngineStore({ borrowerId: id });
  const summary = calc.borrowerSummary(store, id);
  const entry = repo.mapLimit(rows[0]);
  if (summary.limit - entry.incrAmt < summary.outstanding) {
    throw bad('Reversing this entry would leave the limit below the current outstanding.');
  }
  await q('DELETE FROM limit_history WHERE id = ?', [limitId]);
  await audit.log(req, 'borrower.limit.delete', 'borrower', id, me.name + ' reversed a limit entry of ' + entry.incrAmt);

  const after = await repo.loadEngineStore({ borrowerId: id });
  return { ok: true, summary: calc.borrowerSummary(after, id) };
}));

module.exports = { router, rebuildBorrower };
