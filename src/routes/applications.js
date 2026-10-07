'use strict';
/* Applications — the origination pipeline, from proposal to sanction.

   A borrower does not exist until sanction: the proposal, its document
   checklist, the policy run, any §9 deviation, the CAM and the Director's
   decision all live on the application. Recording the sanction terms is what
   opens the borrower and its facility on the live book. */
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { q, tx } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const audit = require('../audit');
const policy = require('../policy');
const settings = require('../settings');
const book = require('../book');
const docstore = require('../docstore');
const los = require('../los');
const letters = require('../letters');
const { notify } = require('../notify');
const { H, bad, fail, notFound, reqStr, optStr, reqNum, optNum, reqDate, optDate, oneOf, reqId, flag } = require('../http');

const router = express.Router();
const ENTITY_TYPES = ['Private Limited', 'LLP', 'Partnership', 'Proprietorship', 'Public Limited'];
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN = /^[0-9A-Z]{15}$/;

/* ---------------- guards ---------------- */
function assertOpen(app, me) {
  if (los.SETTLED.includes(app.stage)) throw bad('This application is ' + app.stage.toLowerCase() + ' — it can no longer be changed.');
  if (['CAM Pending', 'Approved'].includes(app.stage) && me.role !== 'director') {
    throw fail(403, 'This file is with the Director — only a Director can change it now.');
  }
}
const audited = (app) => app.appCode + ' · ' + app.legalName;
const touch = (id) => q('UPDATE credit_applications SET updated_at = NOW(3) WHERE id = ?', [id]);

function cleanVcs(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad('VC tags must be a list.');
  const out = [];
  v.forEach((x) => { const s = String(x || '').trim().slice(0, 120); if (s && !out.includes(s)) out.push(s); });
  if (out.length > 12) throw bad('At most twelve VC / investor tags per application.');
  return out;
}
function cleanPan(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (s && !PAN.test(s)) throw bad('PAN must look like AAACP1234M.');
  return s;
}
function cleanGstin(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (s && !GSTIN.test(s)) throw bad('GSTIN must be 15 letters and digits.');
  return s;
}

/* ---------------- list / funnel / read ---------------- */
router.get('/', H(async (req) => {
  auth.requireUser(req);
  return los.listApplications({
    term: String(req.query.q || '').trim(),
    stage: req.query.stage ? oneOf(req.query.stage, 'Stage', los.STAGES) : '',
    product: req.query.product ? oneOf(req.query.product, 'Product', policy.PRODUCT_KEYS) : ''
  });
}));

router.get('/funnel', H(async (req) => {
  auth.requireUser(req);
  const rows = await q('SELECT stage, COUNT(*) AS n FROM credit_applications GROUP BY stage');
  const counts = Object.fromEntries(los.STAGES.map((s) => [s, 0]));
  rows.forEach((r) => { counts[r.stage] = +r.n; });
  return { counts, total: rows.reduce((s, r) => s + +r.n, 0) };
}));

router.get('/:id', H(async (req) => {
  auth.requireUser(req);
  return los.requireApplication(reqId(req.params.id, 'Application'));
}));

/* ---------------- create ---------------- */
router.post('/', H(async (req) => {
  const me = auth.requireWrite(req);
  const b = req.body || {};
  const product = oneOf(b.product, 'Product', policy.PRODUCT_KEYS);
  const unit = oneOf(b.tenureUnit, 'Tenure unit', ['days', 'months'], 'days');
  const tenureValue = reqNum(b.tenureValue == null || b.tenureValue === '' ? 90 : b.tenureValue, 'Tenure', { min: 1, max: 3650 });
  const f = {
    legalName: reqStr(b.legalName, 'Legal entity name'),
    entityType: oneOf(b.entityType, 'Entity type', ENTITY_TYPES, 'Private Limited'),
    sector: optStr(b.sector, 'Sector', { max: 120 }),
    amount: reqNum(b.requestedAmount, 'Requested amount', { positive: true, max: 1e13 }),
    purpose: optStr(b.purpose, 'Purpose', { max: 2000 }),
    repaymentSource: optStr(b.repaymentSource, 'Repayment source', { max: 2000 }),
    promoterName: optStr(b.promoterName, 'Promoter name', { max: 120 }),
    promoterMobile: optStr(b.promoterMobile, 'Promoter mobile', { max: 40 }),
    pan: cleanPan(b.companyPan), gstin: cleanGstin(b.gstin), vcs: cleanVcs(b.vcs)
  };
  const tenorDays = policy.tenorDaysOf(tenureValue, unit);
  const checklists = await settings.getChecklists();
  const mandatory = [...(checklists.common || []), ...(checklists[product] || [])].some((r) => r.mandatory);

  const r = await q(
    `INSERT INTO credit_applications (legal_name, entity_type, sector, product, requested_amount, tenure_value, tenure_unit,
                                      tenor_days, purpose, repayment_source, promoter_name, promoter_mobile, company_pan,
                                      gstin, vcs, stage, created_by_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [f.legalName, f.entityType, f.sector, product, f.amount, tenureValue, unit, tenorDays, f.purpose, f.repaymentSource,
      f.promoterName, f.promoterMobile, f.pan, f.gstin, JSON.stringify(f.vcs), mandatory ? 'Docs Pending' : 'Policy Check',
      me.id, me.name]);
  await q('UPDATE credit_applications SET app_code = ? WHERE id = ?', [los.nextCode(r.insertId), r.insertId]);

  const app = await los.requireApplication(r.insertId);
  await audit.log(req, 'application.create', 'application', app.id,
    me.name + ' raised ' + audited(app) + ' for ' + policy.inrShort(f.amount) + ' (' + app.productName + ')',
    { product, amount: f.amount, tenorDays });
  return app;
}));

/* ---------------- update the proposal ---------------- */
router.put('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  const b = req.body || {};

  const next = {
    legal_name: b.legalName === undefined ? app.legalName : reqStr(b.legalName, 'Legal entity name'),
    entity_type: b.entityType === undefined ? app.entityType : optStr(b.entityType, 'Entity type', { max: 48 }),
    sector: b.sector === undefined ? app.sector : optStr(b.sector, 'Sector', { max: 120 }),
    purpose: b.purpose === undefined ? app.purpose : optStr(b.purpose, 'Purpose', { max: 2000 }),
    repayment_source: b.repaymentSource === undefined ? app.repaymentSource : optStr(b.repaymentSource, 'Repayment source', { max: 2000 }),
    promoter_name: b.promoterName === undefined ? app.promoterName : optStr(b.promoterName, 'Promoter name', { max: 120 }),
    promoter_mobile: b.promoterMobile === undefined ? app.promoterMobile : optStr(b.promoterMobile, 'Promoter mobile', { max: 40 }),
    company_pan: b.companyPan === undefined ? app.companyPan : cleanPan(b.companyPan),
    gstin: b.gstin === undefined ? app.gstin : cleanGstin(b.gstin),
    vcs: JSON.stringify(b.vcs === undefined ? app.vcs : cleanVcs(b.vcs))
  };
  await q(`UPDATE credit_applications SET legal_name=?, entity_type=?, sector=?, purpose=?, repayment_source=?, promoter_name=?,
             promoter_mobile=?, company_pan=?, gstin=?, vcs=? WHERE id=?`,
  [next.legal_name, next.entity_type, next.sector, next.purpose, next.repayment_source, next.promoter_name,
    next.promoter_mobile, next.company_pan, next.gstin, next.vcs, id]);
  await audit.log(req, 'application.update', 'application', id, me.name + ' edited the proposal for ' + audited(app));
  return los.requireApplication(id);
}));

/* ---------------- delete ---------------- */
router.delete('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  if (los.SETTLED.includes(app.stage)) throw bad('A sanctioned application is part of the record and cannot be deleted.');
  if (me.role !== 'director' && app.createdById !== me.id) throw fail(403, 'Only the Director, or whoever raised it, can delete an application.');

  const files = await q('SELECT rel_path FROM documents WHERE application_id = ?', [id]);
  await q('DELETE FROM credit_applications WHERE id = ?', [id]);   // cascades documents, receivables, deviations
  files.forEach((f) => removeFile(f.rel_path));
  await audit.log(req, 'application.delete', 'application', id, me.name + ' deleted ' + audited(app) + ' (' + files.length + ' document(s))');
  return { ok: true };
}));

function removeFile(relPath) {
  try {
    const abs = path.resolve(config.paths.data, relPath || '');
    if (abs.startsWith(path.resolve(config.paths.data) + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (e) { console.error('[applications] could not remove file:', e.message); }
}

/* ---------------- documents ---------------- */
const categoryFor = (label) => {
  const s = String(label || '');
  if (/bank statement/i.test(s)) return 'Bank statement';
  if (/kyc|pan|aadhaar|incorporation|gst|cheque/i.test(s)) return 'KYC';
  if (/purchase order|invoice|paper|\bpo\b/i.test(s)) return 'Invoice';
  if (/financial|balance|itr|mis|cash-flow|cash flow/i.test(s)) return 'Financials';
  if (/sanction|agreement/i.test(s)) return 'Sanction';
  return 'Other';
};

router.post('/:id/documents', docstore.upload.single('file'), H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);

  const f = docstore.assertPdf(req.file);
  const row = app.documents.find((d) => d.key === req.body.docKey);
  if (!row && req.body.docKey) throw bad('That is not a row on this application’s checklist.');
  const title = optStr(req.body.title, 'Title') || (row ? row.label : f.originalname.replace(/\.pdf$/i, ''));
  const category = oneOf(req.body.category, 'Category', docstore.CATEGORIES, categoryFor(row ? row.label : title));

  const doc = await docstore.saveDocument(q, {
    application: { id, appCode: app.appCode }, file: f, title, category, docKey: row ? row.key : null, user: me
  });
  await notify({ toRole: 'director', type: 'upload', docId: doc.id, customerName: app.legalName,
    message: me.name + ' filed “' + title + '” on ' + app.appCode + ' (' + app.legalName + ') — awaiting your review.' });
  await audit.log(req, 'application.document', 'application', id, me.name + ' filed “' + title + '” on ' + audited(app),
    { documentId: doc.id, docKey: row ? row.key : null });
  await touch(id);
  const after = await los.refreshStage(id);
  return { document: await repo.getDocument(doc.id), stage: after.stage, missingDocs: after.missingDocs };
}));

router.post('/:id/document-rows', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  const label = reqStr(req.body.label, 'Label', { max: 190 });
  if (app.documents.some((d) => d.label.toLowerCase() === label.toLowerCase())) throw bad('That row is already on the checklist.');
  const extra = (await los.getRow(id)).extra_rows;
  const rows = repo.json(extra, []) || [];
  const base = 'x-' + (label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'row');
  let key = base, n = 2;
  while (app.documents.some((d) => d.key === key)) key = base + '-' + n++;
  rows.push({ key, label, mandatory: flag(req.body.mandatory) });
  await q('UPDATE credit_applications SET extra_rows = ? WHERE id = ?', [JSON.stringify(rows), id]);
  await audit.log(req, 'application.document-row', 'application', id, me.name + ' added a checklist row “' + label + '” to ' + audited(app));
  const after = await los.refreshStage(id);
  return { ok: true, key, stage: after.stage };
}));

router.delete('/:id/document-rows/:key', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  const rows = repo.json((await los.getRow(id)).extra_rows, []) || [];
  const hit = rows.find((r) => r.key === req.params.key);
  if (!hit) throw notFound('Only a row added to this application can be removed from it.');
  await q('UPDATE credit_applications SET extra_rows = ? WHERE id = ?', [JSON.stringify(rows.filter((r) => r.key !== hit.key)), id]);
  await audit.log(req, 'application.document-row', 'application', id, me.name + ' removed the checklist row “' + hit.label + '” from ' + audited(app));
  const after = await los.refreshStage(id);
  return { ok: true, stage: after.stage };
}));

/* ---------------- receivables (Quick Cash paper) ---------------- */
const KINDS = ['PO', 'Invoice', 'Bill', 'Platform', 'Other'];

function readReceivable(body) {
  return {
    kind: oneOf(body.kind, 'Kind', KINDS, 'PO'),
    number: reqStr(body.number, 'Number', { max: 80 }),
    buyer: optStr(body.buyer, 'Buyer', { max: 190 }),
    value: reqNum(body.value, 'Value', { positive: true, max: 1e13 }),
    date: optDate(body.date, 'Date'),
    dueDate: optDate(body.dueDate, 'Due date')
  };
}

router.post('/:id/receivables', docstore.upload.single('file'), H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  const r = readReceivable(req.body || {});
  if (app.receivables.some((p) => p.number.toLowerCase() === r.number.toLowerCase())) throw bad('Paper ' + r.number + ' is already tagged on this file.');

  let documentId = null;
  if (req.file) {
    const doc = await docstore.saveDocument(q, {
      application: { id, appCode: app.appCode }, file: docstore.assertPdf(req.file), title: r.kind + ' ' + r.number,
      category: r.kind === 'PO' ? 'PO' : 'Invoice', docKey: 'receivable', user: me
    });
    documentId = doc.id;
  }
  const ins = await q(
    `INSERT INTO application_receivables (application_id, kind, number, buyer, value, doc_date, due_date, document_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, r.kind, r.number, r.buyer, r.value, r.date, r.dueDate, documentId, me.name]);
  await touch(id);
  await audit.log(req, 'application.receivable', 'application', id,
    me.name + ' tagged ' + r.kind + ' ' + r.number + ' (' + policy.inrShort(r.value) + ') on ' + audited(app), { receivableId: ins.insertId });
  return { ok: true, id: ins.insertId };
}));

/* Bulk import: Kind, Number, Buyer, Value, Date, DueDate — a header row is optional. */
router.post('/:id/receivables/bulk', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  const text = String(req.body.text || '');
  if (!text.trim()) throw bad('Paste or choose some rows to import.');

  const have = new Set(app.receivables.map((p) => p.number.toLowerCase()));
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /^kind\b/i.test(lines[0])) lines.shift();
  if (lines.length > 500) throw bad('Import at most 500 rows at a time.');

  let imported = 0, duplicates = 0;
  const problems = [];
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
    try {
      const r = readReceivable({ kind: c[0] || 'PO', number: c[1], buyer: c[2], value: String(c[3] || '').replace(/[₹\s]/g, ''), date: c[4], dueDate: c[5] });
      const kind = KINDS.find((k) => k.toLowerCase() === String(r.kind).toLowerCase()) || r.kind;
      if (have.has(r.number.toLowerCase())) { duplicates++; continue; }
      have.add(r.number.toLowerCase());
      await q(`INSERT INTO application_receivables (application_id, kind, number, buyer, value, doc_date, due_date, created_by)
               VALUES (?,?,?,?,?,?,?,?)`, [id, kind, r.number, r.buyer, r.value, r.date, r.dueDate, me.name]);
      imported++;
    } catch (e) { problems.push('Row ' + (i + 1) + ': ' + e.message); }
  }
  if (!imported && !duplicates) throw bad(problems.length ? problems.slice(0, 3).join(' ') : 'No rows could be read.');
  await touch(id);
  await audit.log(req, 'application.receivable', 'application', id,
    me.name + ' bulk-imported ' + imported + ' receivable(s) on ' + audited(app), { imported, duplicates, problems: problems.length });
  return { imported, duplicates, problems };
}));

router.delete('/:id/receivables/:paperId', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const paperId = reqId(req.params.paperId, 'Receivable');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  const hit = app.receivables.find((p) => p.id === paperId);
  if (!hit) throw notFound('Receivable not found.');
  await q('DELETE FROM application_receivables WHERE id = ?', [paperId]);
  if (hit.documentId) {
    const [doc] = await q('SELECT rel_path FROM documents WHERE id = ?', [hit.documentId]);
    await q('DELETE FROM documents WHERE id = ?', [hit.documentId]);
    if (doc) removeFile(doc.rel_path);
  }
  await touch(id);
  await audit.log(req, 'application.receivable', 'application', id, me.name + ' removed ' + hit.kind + ' ' + hit.number + ' from ' + audited(app));
  return { ok: true };
}));

/* Quick Cash tenor follows the paper: the latest due date plus a 30-day grace,
   inside the product band of 30–120 days. */
router.get('/:id/tenor-suggestion', H(async (req) => {
  auth.requireUser(req);
  const app = await los.requireApplication(reqId(req.params.id, 'Application'));
  const from = optDate(req.query.from, 'From date', calc.td());
  const dues = app.receivables.map((p) => p.dueDate).filter(Boolean).sort();
  if (!dues.length) return { days: null, basis: 'No paper with a payment due date is tagged yet.' };
  const latest = dues[dues.length - 1];
  const raw = calc.di(from, latest) - 1 + 30;
  const [lo, hi] = policy.PRODUCTS.quick_cash.tenorDays;
  const days = Math.max(lo, Math.min(hi, raw));
  return { days, rawDays: raw, latestDue: latest, graceDays: 30,
    basis: 'Latest due date ' + latest + ' plus 30 days of grace' + (days !== raw ? ', held to the ' + lo + '–' + hi + ' day band' : '') + '.' };
}));

/* ---------------- gate inputs and the rate build ---------------- */
const NUM_KEYS = ['cibil', 'opYears', 'bounces12m', 'roundSize', 'roundAgeMonths', 'runwayMonths', 'avgMonthlyRevenue',
  'monthlyBurn', 'existingDebt', 'netCashSurplus', 'exitAmount'];
const STR_KEYS = ['fundingReason', 'leadInvestor', 'exitPrimary', 'exitBackup'];
const BOOL_KEYS = ['wilfulDefault', 'anchorListed'];

function cleanEligibility(input, prior) {
  const out = Object.assign({}, prior);
  const x = input || {};
  NUM_KEYS.forEach((k) => {
    if (!(k in x)) return;
    out[k] = x[k] === '' || x[k] == null ? '' : reqNum(x[k], k, { min: -1e14, max: 1e14 });
  });
  STR_KEYS.forEach((k) => { if (k in x) out[k] = optStr(x[k], k, { max: 190 }); });
  BOOL_KEYS.forEach((k) => { if (k in x) out[k] = flag(x[k]); });
  if ('receivableType' in x) out.receivableType = oneOf(x.receivableType, 'Receivable quality', ['platform', 'corporate', 'other'], 'other');
  if ('exitPrimaryQuality' in x) out.exitPrimaryQuality = oneOf(x.exitPrimaryQuality, 'Primary exit quality', ['confirmed', 'likely', 'weak'], 'likely');
  if (x.statementSource && typeof x.statementSource === 'object') {
    const s = x.statementSource;
    out.statementSource = { documentId: +s.documentId || null, title: String(s.title || '').slice(0, 190),
      period: String(s.period || '').slice(0, 60), readAt: s.readAt ? String(s.readAt).slice(0, 40) : null };
  }
  return out;
}

function cleanRate(input, prior) {
  const out = Object.assign({}, prior, { saved: true });
  const x = input || {};
  const step = (v, label, lim) => {
    const n = reqNum(v, label, { min: -lim, max: lim });
    if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) throw bad(label + ' moves in steps of 0.5%.');
    return n;
  };
  if ('qAdj' in x) out.qAdj = step(x.qAdj, 'Quality adjustment', 2);
  if ('sAdj' in x) out.sAdj = step(x.sAdj, 'Structure adjustment', 1);
  ['qComment', 'sComment', 'tenorComment'].forEach((k) => { if (k in x) out[k] = optStr(x[k], k, { max: 400 }); });
  return out;
}

router.put('/:id/eligibility', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  const b = req.body || {};

  const eligibility = b.eligibility ? cleanEligibility(b.eligibility, app.eligibility) : app.eligibility;
  const rateRaw = repo.json((await los.getRow(id)).rate_build, {}) || {};
  const rate = b.rate ? cleanRate(b.rate, rateRaw) : rateRaw;

  let amount = app.requestedAmount, tenureValue = app.tenureValue, unit = app.tenureUnit;
  if (b.requestedAmount !== undefined && b.requestedAmount !== '') amount = reqNum(b.requestedAmount, 'Requested amount', { positive: true, max: 1e13 });
  if (b.tenureUnit !== undefined) unit = oneOf(b.tenureUnit, 'Tenure unit', ['days', 'months']);
  if (b.tenureValue !== undefined && b.tenureValue !== '') tenureValue = reqNum(b.tenureValue, 'Tenure', { min: 1, max: 3650 });

  await q(`UPDATE credit_applications SET eligibility = ?, rate_build = ?, requested_amount = ?, tenure_value = ?, tenure_unit = ?,
             tenor_days = ? WHERE id = ?`,
  [JSON.stringify(eligibility), JSON.stringify(rate), amount, tenureValue, unit, policy.tenorDaysOf(tenureValue, unit), id]);
  await audit.log(req, 'application.eligibility', 'application', id, me.name + ' saved the gate inputs for ' + audited(app),
    { amount, tenureValue, unit, source: eligibility.statementSource || null });
  return los.requireApplication(id);
}));

/* ---------------- the policy check ---------------- */
router.post('/:id/policy-check', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  if (app.stage === 'Docs Pending') throw bad('File every mandatory document first — ' + app.missingDocs + ' still outstanding.');
  if (app.stage === 'Declined') throw bad('This application is declined — reopen it to run the policy check.');

  const rate = repo.json((await los.getRow(id)).rate_build, {}) || {};
  if (!String(rate.tenorComment || '').trim()) throw bad('The tenure justification is mandatory before the policy check will run.');
  if (+rate.qAdj && !String(rate.qComment || '').trim()) throw bad('The quality adjustment needs a written justification.');
  if (+rate.sAdj && !String(rate.sComment || '').trim()) throw bad('The structure adjustment needs a written justification.');

  const [pol, weights, ctxBook, tier] = await Promise.all([
    settings.getPolicy(), settings.getWeights(), book.liveBook(),
    settings.investorTierFor(app.eligibility.leadInvestor)
  ]);
  const result = policy.runPolicy({
    app, e: app.eligibility, rate, recv: app.receivables, policy: pol, weights, investorTier: tier,
    book: {
      liveBook: ctxBook.liveBook, bulletOutstanding: ctxBook.bulletOutstanding, vcExposure: ctxBook.vcExposure,
      groupExposure: ctxBook.groupExposure({ pan: app.companyPan, name: app.legalName })
    }
  });
  await q('UPDATE credit_applications SET policy_check = ? WHERE id = ?', [JSON.stringify(result), id]);
  await audit.log(req, 'application.policy-check', 'application', id,
    me.name + ' ran the policy check on ' + audited(app) + ' — ' + result.verdict.replace(/_/g, ' ') + ', eligible ' + policy.inrShort(result.eligible),
    { verdict: result.verdict, eligible: result.eligible, grade: result.score.grade, binding: result.binding });
  return los.requireApplication(id);
}));

/* ---------------- §9 deviations ---------------- */
router.post('/:id/deviation', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  const rc = app.policyCheck;
  if (!rc) throw bad('Run the policy check first — a deviation is raised against a failed gate.');
  if (rc.verdict !== 'DEVIATION_REQUIRED') {
    throw bad(rc.verdict === 'DECLINE' ? 'A hard stop cannot be deviated — it is a decline.' : 'The policy check passed — there is nothing to deviate from.');
  }
  if (app.deviation && app.deviation.status === 'pending') throw bad('A deviation is already with the Director.');
  if (app.deviation && app.deviation.status === 'approved') throw bad('The deviation on this file is already approved.');
  if (app.devCount >= policy.DEVIATION_MAX) throw bad('§9: both deviations are used — a third is a decline.');

  const reason = reqStr(req.body.reason, 'The gate(s) being deviated and why', { max: 2000 });
  const catalogue = policy.DEVIATION_CONTROLS;
  const controls = (Array.isArray(req.body.controls) ? req.body.controls : []).map((c) => String(c).trim()).filter(Boolean);
  const note = optStr(req.body.note, 'Further detail', { max: 2000 });
  if (!controls.length && !note) throw bad('§9 needs at least one compensating control.');
  controls.forEach((c) => { if (!catalogue.includes(c)) throw bad('“' + c.slice(0, 60) + '” is not one of the offered compensating controls.'); });

  const n = app.devCount + 1;
  const r = await q(
    `INSERT INTO application_deviations (application_id, n, reason, controls, note, raised_by_id, raised_by) VALUES (?,?,?,?,?,?,?)`,
    [id, n, reason, JSON.stringify(controls), note, me.id, me.name]);
  await touch(id);
  await notify({ toRole: 'director', type: 'deviation', customerName: app.legalName,
    message: me.name + ' raised deviation ' + n + ' of 2 on ' + app.appCode + ' (' + app.legalName + ') — awaiting your decision.' });
  await audit.log(req, 'application.deviation.raised', 'application', id, me.name + ' raised deviation ' + n + ' of 2 on ' + audited(app),
    { deviationId: r.insertId, controls, reason });
  return los.requireApplication(id);
}));

router.post('/:id/deviation/decide', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  const dev = app.deviation;
  if (!dev || dev.status !== 'pending') throw bad('There is no deviation waiting for a decision.');
  await book.assertChecker(me, dev.raisedById, 'deviation');

  const approve = flag(req.body.approve);
  const comment = optStr(req.body.comment, 'Comment', { max: 2000 });
  const bump = approve ? reqNum(req.body.pricingBump == null ? 1 : req.body.pricingBump, '§9 pricing bump', { min: 0, max: 2 }) : 0;
  if (approve && ![0, 1, 2].includes(bump)) throw bad('The §9 pricing bump is +1%, +2%, or none.');
  if (!approve && !comment) throw bad('A reason is required to reject a deviation.');
  if (approve && bump === 0 && !comment) throw bad('Record in the comment why no pricing bump applies.');

  await q(`UPDATE application_deviations SET status = ?, decided_by = ?, decided_at = NOW(3), checker_comment = ?, pricing_bump = ? WHERE id = ?`,
    [approve ? 'approved' : 'rejected', me.name, comment, bump, dev.id]);
  await touch(id);
  if (dev.raisedById) {
    await notify({ toUserId: dev.raisedById, type: 'decision', customerName: app.legalName,
      message: 'Deviation ' + dev.n + ' on ' + app.appCode + ' (' + app.legalName + ') was ' + (approve ? 'approved' : 'rejected') +
        (approve && bump ? ', priced at +' + bump + '%' : '') + (comment ? ': ' + comment : '.') });
  }
  await audit.log(req, 'application.deviation.' + (approve ? 'approved' : 'rejected'), 'application', id,
    me.name + (approve ? ' approved' : ' rejected') + ' deviation ' + dev.n + ' on ' + audited(app), { bump, comment });
  return los.requireApplication(id);
}));

/* ---------------- CAM ---------------- */
function cleanCam(input, prior) {
  const out = Object.assign({}, prior);
  los.CAM_KEYS.forEach((k) => { if (input && k in input) out[k] = optStr(input[k], k, { max: 12000 }); });
  return out;
}
async function writeCam(id, cam) { await q('UPDATE credit_applications SET cam = ? WHERE id = ?', [JSON.stringify(cam), id]); }

router.post('/:id/cam/start', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  if (app.stage === 'CAM') return app;
  if (app.stage !== 'Policy Check') throw bad('The CAM starts from the policy check — this file is at ' + app.stage + '.');
  const rc = app.policyCheck;
  if (!rc) throw bad('Run the policy check first — the CAM embeds its snapshot.');
  const cleared = ['PASS', 'APPROVE_LOWER'].includes(rc.verdict) || (app.deviation && app.deviation.status === 'approved');
  if (!cleared) throw bad('The policy check does not clear this file — it needs an approved §9 deviation first.');
  await writeCam(id, Object.assign({}, app.cam, { status: 'draft' }));
  await q("UPDATE credit_applications SET stage = 'CAM' WHERE id = ?", [id]);
  await audit.log(req, 'application.cam.start', 'application', id, me.name + ' started the CAM for ' + audited(app));
  return los.requireApplication(id);
}));

router.put('/:id/cam', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  if (app.stage !== 'CAM') throw bad('The CAM can be edited only while the file is at the CAM stage.');
  if (app.cam.status === 'pending' || app.cam.status === 'approved') throw bad('The CAM is with the Director and is locked.');
  await writeCam(id, cleanCam(req.body, app.cam));
  await touch(id);
  await audit.log(req, 'application.cam.save', 'application', id, me.name + ' saved the CAM draft for ' + audited(app));
  return los.requireApplication(id);
}));

router.post('/:id/cam/submit', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  if (app.stage !== 'CAM') throw bad('Only a file at the CAM stage can be sent to the Director.');
  const cam = cleanCam(req.body, app.cam);
  if (!String(cam.pdNotes || '').trim()) throw bad('The personal-discussion notes are mandatory before the CAM goes up.');
  if (!String(cam.repaymentTools || '').trim()) throw bad('The repayment tools / source of repayment is mandatory before the CAM goes up.');
  Object.assign(cam, { status: 'pending', submittedBy: me.name, submittedById: me.id, submittedAt: new Date().toISOString(), comment: '' });
  await writeCam(id, cam);
  await q("UPDATE credit_applications SET stage = 'CAM Pending' WHERE id = ?", [id]);
  await notify({ toRole: 'director', type: 'cam', customerName: app.legalName,
    message: me.name + ' sent the CAM for ' + app.appCode + ' (' + app.legalName + ', ' + policy.inrShort(app.requestedAmount) + ') — awaiting your decision.' });
  await audit.log(req, 'application.cam.submitted', 'application', id, me.name + ' sent the CAM for ' + audited(app) + ' to the Director');
  return los.requireApplication(id);
}));

router.post('/:id/cam/decide', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  if (app.stage !== 'CAM Pending') throw bad('There is no CAM waiting for a decision on this file.');
  await book.assertChecker(me, app.cam.submittedById, 'CAM');

  const approve = flag(req.body.approve);
  const note = optStr(req.body.note, 'Note', { max: 2000 });
  if (!approve && !note) throw bad('A reason is required to decline the application.');

  const cam = Object.assign({}, app.cam, {
    status: approve ? 'approved' : 'rejected', decidedBy: me.name, decidedById: me.id, decidedAt: new Date().toISOString(), comment: note
  });
  await writeCam(id, cam);
  if (approve) await q("UPDATE credit_applications SET stage = 'Approved' WHERE id = ?", [id]);
  else await q("UPDATE credit_applications SET stage = 'Declined', decline_reason = ? WHERE id = ?", [note, id]);

  if (app.cam.submittedById) {
    await notify({ toUserId: app.cam.submittedById, type: 'decision', customerName: app.legalName,
      message: 'The CAM for ' + app.appCode + ' (' + app.legalName + ') was ' + (approve ? 'approved' : 'declined') + (note ? ': ' + note : '.') });
  }
  await audit.log(req, 'application.cam.' + (approve ? 'approved' : 'declined'), 'application', id,
    me.name + (approve ? ' approved' : ' declined') + ' the CAM for ' + audited(app), { note });
  return los.requireApplication(id);
}));

router.post('/:id/cam/rework', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  if (app.cam.status !== 'rejected') throw bad('Only a rejected CAM can be reopened for rework.');
  await writeCam(id, Object.assign({}, app.cam, { status: 'draft' }));
  await q("UPDATE credit_applications SET stage = 'CAM', decline_reason = '' WHERE id = ?", [id]);
  await audit.log(req, 'application.cam.rework', 'application', id, me.name + ' reopened the CAM for ' + audited(app) + ' for rework');
  return los.requireApplication(id);
}));

/* ---------------- decline / reopen ---------------- */
router.post('/:id/decline', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  assertOpen(app, me);
  if (app.stage === 'Declined') throw bad('This application is already declined.');
  const reason = reqStr(req.body.reason, 'Reason', { max: 500 });
  await q("UPDATE credit_applications SET stage = 'Declined', decline_reason = ? WHERE id = ?", [reason, id]);
  await audit.log(req, 'application.declined', 'application', id, me.name + ' declined ' + audited(app) + ': ' + reason, { from: app.stage });
  return los.requireApplication(id);
}));

router.post('/:id/reopen', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  if (app.stage !== 'Declined') throw bad('Only a declined application can be reopened.');
  const stage = app.missingDocs > 0 ? 'Docs Pending' : 'Policy Check';
  if (app.cam.status === 'rejected') await writeCam(id, Object.assign({}, app.cam, { status: 'draft' }));
  await q('UPDATE credit_applications SET stage = ?, decline_reason = ? WHERE id = ?', [stage, '', id]);
  await audit.log(req, 'application.reopen', 'application', id, me.name + ' reopened ' + audited(app) + ' at ' + stage);
  return los.requireApplication(id);
}));

/* ---------------- sanction: opens the borrower and its facility ---------------- */
router.post('/:id/sanction', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Application');
  const app = await los.requireApplication(id);
  if (app.stage !== 'Approved') throw bad('Sanction unlocks once the Director approves the CAM — this file is at ' + app.stage + '.');
  const rc = app.policyCheck;
  const dev = app.deviation && app.deviation.status === 'approved' ? app.deviation : null;
  const pol = await settings.getPolicy();

  const b = req.body || {};
  const amount = reqNum(b.amount, 'Sanctioned amount', { positive: true, max: 1e13 });
  const tenorDays = Math.round(reqNum(b.tenorDays == null || b.tenorDays === '' ? app.tenorDays : b.tenorDays, 'Tenor per tranche', { min: 1, max: 3650 }));
  const pfPct = reqNum(b.pfPct == null || b.pfPct === '' ? 1 : b.pfPct, 'Processing fee', { min: 0, max: 100 });
  const penalPct = reqNum(b.penalPct == null || b.penalPct === '' ? pol.penalDefault : b.penalPct, 'Penal spread', { min: 0, max: 100 });
  const sanctionDate = optDate(b.sanctionDate, 'Sanction date', calc.td());
  const expiry = optDate(b.expiry, 'Facility validity', calc.addYearISO(sanctionDate));
  if (expiry <= sanctionDate) throw bad('The facility validity must fall after the sanction date.');
  if (amount > rc.eligible + 0.5 && !dev) throw bad('That is above the policy-eligible ' + policy.inr(rc.eligible) + ' — it needs an approved §9 deviation.');
  if (amount > app.requestedAmount + 0.5) throw bad('The sanction cannot exceed the ' + policy.inr(app.requestedAmount) + ' requested.');

  const bump = dev ? dev.pricingBump : 0;
  const rate = +(rc.rate.final + bump).toFixed(2);
  const sanction = {
    amount, rate, pricingBump: bump, tenorDays, pfPct, gstPct: pol.gstPct, penalPct, sanctionDate, expiry,
    sanctionedBy: me.name, sanctionedAt: new Date().toISOString(), policyVersion: rc.policyVersion
  };

  const dupe = await q('SELECT id FROM borrowers WHERE name = ? LIMIT 1', [app.legalName]);
  if (dupe.length) throw bad('A borrower named “' + app.legalName + '” already exists on the book.');

  const borrowerId = await tx(async (cx) => {
    const slug = await repo.uniqueSlug(app.legalName, cx.q);
    const ins = await cx.q(
      `INSERT INTO borrowers (slug, name, biz, loan_type, base_limit, rate, pen_rate, proc_fee_pct, gst_pct, tenure, tenure_unit,
                              sanction_date, contact_name, contact_phone, pan, gstin, product, application_id, vcs, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'days', ?,?,?,?,?,?,?,?,?)`,
      [slug, app.legalName, app.sector, app.product === 'bullet' ? 'io' : 'po', amount, rate, penalPct, pfPct, pol.gstPct, tenorDays,
        sanctionDate, app.promoterName, app.promoterMobile, app.companyPan, app.gstin, app.product, id,
        JSON.stringify(app.vcs), me.name]);
    const newId = ins.insertId;
    // The rows are re-pointed, the files are not moved — a link filed during origination never breaks.
    await cx.q('UPDATE documents SET borrower_id = ? WHERE application_id = ?', [newId, id]);
    /* A validity longer than a year is carried as a zero-amount limit event, so the
       review clock (latest event + 1 year) lands on the agreed expiry. */
    const clock = calc.addYearISO(sanctionDate);
    if (expiry > clock) {
      const d = new Date(expiry); d.setFullYear(d.getFullYear() - 1);
      await cx.q('INSERT INTO limit_history (borrower_id, event_date, incr_amt, note, created_by) VALUES (?,?,0,?,?)',
        [newId, d.toISOString().slice(0, 10), 'Facility validity set at sanction (' + expiry + ')', me.name]);
    }
    await cx.q("UPDATE credit_applications SET stage = 'Sanctioned', sanction = ?, borrower_id = ? WHERE id = ?",
      [JSON.stringify(sanction), newId, id]);
    return newId;
  });

  await notify({ toRole: 'manager', type: 'sanction', borrowerId, customerName: app.legalName,
    message: app.legalName + ' was sanctioned ' + policy.inrShort(amount) + ' at ' + rate + '% — the facility is live on the book.' });
  await audit.log(req, 'application.sanction', 'application', id,
    me.name + ' sanctioned ' + audited(app) + ' for ' + policy.inrShort(amount) + ' at ' + rate + '%', { ...sanction, borrowerId });
  return los.requireApplication(id);
}));

/* ---------------- generated paperwork ---------------- */
router.get('/:id/letter/:kind', async (req, res, next) => {
  try {
    auth.requireUser(req);
    const kind = oneOf(req.params.kind, 'Document', ['cam', 'sanction', 'agreement']);
    const app = await los.requireApplication(reqId(req.params.id, 'Application'));
    const html = await letters.render(kind, app);
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="' + app.appCode + '-' + kind + '.html"');
    }
    res.send(html);
  } catch (e) { next(e); }
});

module.exports = router;
