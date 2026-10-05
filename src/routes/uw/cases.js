'use strict';
/* Underwriting cases: intake, identity, facility, proposed terms, readiness,
   history and snapshots (spec §3, §10 "Pipeline and case"). */
const express = require('express');
const { q, tx } = require('../../db/pool');
const audit = require('../../audit');
const config = require('../../config');
const money = require('../../uw/money');
const uwrepo = require('../../uw/repo');
const access = require('../../uw/access');
const readiness = require('../../uw/readiness');
const checklist = require('../../uw/checklist');
const snapshot = require('../../uw/snapshot');
const vocab = require('../../uw/vocab');
const bank = require('../../uw/bank');
const { H, bad, reqStr, optStr, reqId, optId, optDate } = require('../../http');

const router = express.Router();

/* ---------------- meta: vocabularies for the UI ---------------- */
router.get('/meta', H(async (req) => {
  access.requireMaker(req);
  const [products, fields, users, sources] = await Promise.all([
    q('SELECT product_key, label, active FROM uw_products ORDER BY label'),
    q('SELECT * FROM uw_field_codes ORDER BY category, label'),
    q("SELECT id, name, role FROM users WHERE active = 1 ORDER BY FIELD(role,'director','manager','analyst'), name"),
    q('SELECT id, name, url, search_identifiers, active FROM uw_sources ORDER BY name')
  ]);
  return {
    products: products.map((p) => ({ key: p.product_key, label: p.label, active: !!p.active })),
    fieldCodes: fields.map(uwrepo.mapFieldCode),
    users,
    sources: sources.map((s) => ({ id: s.id, name: s.name, url: s.url, searchIdentifiers: s.search_identifiers, active: !!s.active })),
    docTypes: vocab.DOC_TYPES.map(([key, label]) => ({ key, label })),
    auditStatuses: vocab.AUDIT_STATUSES, bases: vocab.BASES, units: money.UNITS,
    creditCategories: vocab.CREDIT_CATEGORIES, debitCategories: vocab.DEBIT_CATEGORIES,
    dateFormats: bank.DATE_FORMATS, checkStatuses: vocab.CHECK_STATUSES, matchConfidence: vocab.MATCH_CONFIDENCE,
    supportStates: vocab.SUPPORT_STATES, ruleClasses: vocab.RULE_CLASSES, operators: vocab.OPERATORS,
    controlAreas: vocab.CONTROL_AREAS, caseMetrics: vocab.CASE_METRICS.map(([key, type, label]) => ({ key, type, label })),
    memoSections: vocab.MEMO_SECTIONS.map(([key, label]) => ({ key, label })),
    services: {
      ocr: { configured: false, note: 'No OCR service in Phase 1 — scanned pages are read by the analyst.' },
      llm: { configured: false, note: 'No language model connected in Phase 1. Facts and memo text are entered by analysts; the citation validator applies to all text.' },
      malwareScan: { configured: !!config.uw.clamscanPath, note: config.uw.clamscanPath ? 'ClamAV' : 'Not configured — files are recorded as "not scanned".' }
    },
    limits: {
      maxFileMb: Math.round(config.uw.maxFileBytes / 1048576), maxBatchFiles: config.uw.maxBatchFiles,
      zipMaxDepth: config.uw.zipMaxDepth, zipMaxEntries: config.uw.zipMaxEntries,
      zipMaxTotalMb: Math.round(config.uw.zipMaxTotalBytes / 1048576), zipMaxRatio: config.uw.zipMaxRatio
    }
  };
}));

/* ---------------- list ---------------- */
router.get('/cases', H(async (req) => {
  access.requireMaker(req);
  const where = [], args = [];
  if (req.query.status) {
    const st = String(req.query.status).split(',').filter((s) => vocab.CASE_STATUSES.includes(s));
    if (st.length) { where.push('c.status IN (?)'); args.push(st); }
  }
  if (req.query.q) {
    const like = '%' + String(req.query.q).trim() + '%';
    where.push('(p.legal_name LIKE ? OR c.case_code LIKE ? OR p.pan LIKE ? OR p.gstin LIKE ? OR p.cin LIKE ?)');
    args.push(like, like, like, like, like);
  }
  if (req.query.mine === '1') { where.push('c.analyst_id = ?'); args.push(req.user.id); }
  const rows = await q(
    `SELECT c.*, p.legal_name, u.name AS analyst_name,
            (SELECT COUNT(*) FROM uw_document_versions v WHERE v.case_id = c.id AND v.intake_status <> 'duplicate') AS doc_count,
            (SELECT COUNT(*) FROM uw_document_versions v WHERE v.case_id = c.id AND v.intake_status = 'quarantined') AS quarantined,
            (SELECT COUNT(*) FROM uw_facts f WHERE f.case_id = c.id AND f.is_current = 1) AS fact_count,
            (SELECT COUNT(*) FROM uw_public_checks pc WHERE pc.case_id = c.id AND pc.status = 'pending') AS checks_pending,
            (SELECT COUNT(*) FROM uw_questions qq WHERE qq.case_id = c.id AND qq.status = 'open') AS questions_open
       FROM uw_cases c JOIN uw_parties p ON p.id = c.party_id LEFT JOIN users u ON u.id = c.analyst_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.updated_at DESC LIMIT 500`, args);
  return rows.map((r) => Object.assign(uwrepo.mapCase(r), {
    docCount: Number(r.doc_count), quarantined: Number(r.quarantined), factCount: Number(r.fact_count),
    checksPending: Number(r.checks_pending), questionsOpen: Number(r.questions_open)
  }));
}));

/* ---------------- create ---------------- */
function readParty(b) {
  const list = (v, label, max = 50) => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw bad(label + ' must be a list.');
    if (v.length > max) throw bad('Too many ' + label.toLowerCase() + '.');
    return v;
  };
  const pan = optStr(b.pan, 'PAN', { max: 10 }).toUpperCase();
  const gstin = optStr(b.gstin, 'GSTIN', { max: 15 }).toUpperCase();
  const cin = optStr(b.cin, 'CIN', { max: 24 }).toUpperCase();
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw bad('PAN must look like AAAAA9999A.');
  if (gstin && !/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(gstin)) throw bad('GSTIN must be 15 characters (2-digit state code + PAN + 3).');
  return {
    legalName: reqStr(b.legalName, 'Legal name'),
    entityType: optStr(b.entityType, 'Entity type', { max: 40 }) || 'company',
    pan, gstin, cin,
    aliases: list(b.aliases, 'Aliases').map((a) => reqStr(a, 'Alias')),
    directors: list(b.directors, 'Directors').map((d) => ({ name: reqStr(d.name, 'Director name'), din: optStr(d.din, 'DIN', { max: 12 }), pan: optStr(d.pan, 'Director PAN', { max: 10 }).toUpperCase() })),
    related: list(b.related, 'Related entities').map((r) => ({ name: reqStr(r.name, 'Related entity'), relation: optStr(r.relation, 'Relation', { max: 80 }), identifier: optStr(r.identifier, 'Identifier', { max: 24 }) }))
  };
}

function readFacility(b, partial = false) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('product')) out.product = reqStr(b.product, 'Product', { max: 40 });
  if (has('requestedAmount')) {
    const p = money.paiseNumber(b.requestedAmount, 'INR', 'Requested amount');
    if (p.error) throw bad(p.error);
    if (p.paise <= 0) throw bad('Requested amount must be greater than zero.');
    out.requestedPaise = p.paise;
  }
  if (has('tenorDays')) {
    const t = Number(b.tenorDays);
    if (!Number.isInteger(t) || t < 1 || t > 3650) throw bad('Tenor must be a whole number of days between 1 and 3650.');
    out.tenorDays = t;
  }
  if (has('purpose')) out.purpose = reqStr(b.purpose, 'Purpose', { max: 2000 });
  if (has('repaymentSource')) out.repaymentSource = reqStr(b.repaymentSource, 'Repayment source', { max: 2000 });
  if (has('sector')) out.sector = optStr(b.sector, 'Sector', { max: 120 });
  if (has('vintageYears')) {
    if (b.vintageYears == null || b.vintageYears === '') out.vintageYears = null;
    else {
      const v = Number(b.vintageYears);
      if (!(v >= 0 && v <= 200)) throw bad('Vintage must be between 0 and 200 years.');
      out.vintageYears = Math.round(v * 100) / 100;
    }
  }
  if (has('analystId')) out.analystId = optId(b.analystId, 'Analyst');
  if (has('dueDate')) out.dueDate = optDate(b.dueDate, 'Due date');
  return out;
}

router.post('/cases', H(async (req) => {
  const me = access.requireMaker(req);
  const f = readFacility(req.body);
  const prod = await q('SELECT product_key FROM uw_products WHERE product_key = ? AND active = 1', [f.product]);
  if (!prod.length) throw bad('Unknown or inactive product.');
  const parentId = optId(req.body.parentCaseId, 'Parent case');
  if (parentId && !(await uwrepo.getCase(parentId))) throw bad('Parent case not found.');
  if (f.analystId) {
    const u = await q('SELECT id FROM users WHERE id = ? AND active = 1', [f.analystId]);
    if (!u.length) throw bad('Assigned analyst not found.');
  }

  const id = await tx(async (cx) => {
    let partyId = optId(req.body.partyId, 'Borrower');
    if (partyId) {
      const p = await cx.q('SELECT id FROM uw_parties WHERE id = ?', [partyId]);
      if (!p.length) throw bad('Borrower record not found.');
    } else {
      const p = readParty(req.body.party || {});
      const r = await cx.q(
        'INSERT INTO uw_parties (entity_type, legal_name, cin, pan, gstin, aliases, directors, related, created_by_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [p.entityType, p.legalName, p.cin, p.pan, p.gstin, JSON.stringify(p.aliases), JSON.stringify(p.directors), JSON.stringify(p.related), me.id, me.name]);
      partyId = r.insertId;
    }
    const r = await cx.q(
      `INSERT INTO uw_cases (case_code, party_id, parent_case_id, product, requested_paise, tenor_days, purpose, repayment_source,
                             sector, vintage_years, analyst_id, due_date, created_by_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['tmp-' + require('crypto').randomBytes(8).toString('hex'), partyId, parentId, f.product, f.requestedPaise, f.tenorDays,
        f.purpose, f.repaymentSource, f.sector || '', f.vintageYears ?? null, f.analystId || me.id, f.dueDate || null, me.id, me.name]);
    const code = 'UW-' + new Date().getFullYear() + '-' + String(r.insertId).padStart(5, '0');
    await cx.q('UPDATE uw_cases SET case_code = ? WHERE id = ?', [code, r.insertId]);
    return r.insertId;
  });
  const c = await uwrepo.getCase(id);
  await audit.log(req, 'uw.case.create', 'uw_case', id, me.name + ' opened ' + c.caseCode + ' for ' + c.legalName,
    { product: c.product, requestedPaise: c.requestedPaise, tenorDays: c.tenorDays });
  await access.changed(id, me, 'case opened');
  return c;
}));

/* ---------------- detail ---------------- */
router.get('/cases/:id', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const party = await uwrepo.getParty(c.partyId);
  const decisions = (await q('SELECT * FROM uw_decisions WHERE case_id = ? ORDER BY id', [c.id])).map(uwrepo.mapDecision);
  const snaps = await q('SELECT id, revision, sha256, created_by, created_at FROM uw_snapshots WHERE case_id = ? ORDER BY id', [c.id]);
  const [counts] = await q(
    `SELECT (SELECT COUNT(*) FROM uw_document_versions WHERE case_id = ? AND intake_status = 'accepted') AS accepted,
            (SELECT COUNT(*) FROM uw_document_versions WHERE case_id = ? AND intake_status = 'quarantined') AS quarantined,
            (SELECT COUNT(*) FROM uw_document_versions WHERE case_id = ? AND intake_status = 'duplicate') AS duplicates,
            (SELECT COUNT(*) FROM uw_facts WHERE case_id = ? AND is_current = 1) AS facts,
            (SELECT COUNT(*) FROM uw_transactions WHERE case_id = ? AND duplicate_of_id IS NULL) AS transactions,
            (SELECT COUNT(*) FROM uw_public_checks WHERE case_id = ?) AS checks,
            (SELECT COUNT(*) FROM uw_questions WHERE case_id = ? AND status = 'open') AS openQuestions`,
    [c.id, c.id, c.id, c.id, c.id, c.id, c.id]);
  const children = await q('SELECT id, case_code, status FROM uw_cases WHERE parent_case_id = ?', [c.id]);
  return {
    case: c, party, decisions,
    snapshots: snaps.map((s) => ({ id: s.id, revision: s.revision, sha256: s.sha256, createdBy: s.created_by, createdAt: uwrepo.iso(s.created_at) })),
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
    children: children.map((x) => ({ id: x.id, caseCode: x.case_code, status: x.status })),
    editable: vocab.EDITABLE_STATUSES.includes(c.status)
  };
}));

/* ---------------- facility edits ---------------- */
router.put('/cases/:id', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const f = readFacility(req.body, true);
  if (f.product) {
    const prod = await q('SELECT product_key FROM uw_products WHERE product_key = ? AND active = 1', [f.product]);
    if (!prod.length) throw bad('Unknown or inactive product.');
  }
  const COLS = { product: 'product', requestedPaise: 'requested_paise', tenorDays: 'tenor_days', purpose: 'purpose',
    repaymentSource: 'repayment_source', sector: 'sector', vintageYears: 'vintage_years', analystId: 'analyst_id', dueDate: 'due_date' };
  const sets = [], args = [], diff = {};
  for (const [k, col] of Object.entries(COLS)) {
    if (f[k] === undefined || String(f[k]) === String(c[k])) continue;
    sets.push(col + ' = ?'); args.push(f[k]); diff[k] = { from: c[k], to: f[k] };
  }
  if (!sets.length) return c;
  await q('UPDATE uw_cases SET ' + sets.join(', ') + ' WHERE id = ?', args.concat([c.id]));
  await audit.log(req, 'uw.case.update', 'uw_case', c.id, me.name + ' updated the facility on ' + c.caseCode, diff);
  const ch = await access.changed(c.id, me, 'facility updated');
  return Object.assign(await uwrepo.getCase(c.id), ch);
}));

router.put('/cases/:id/party', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const before = await uwrepo.getParty(c.partyId);
  const p = readParty(Object.assign({}, before, req.body));
  const state = req.body.identityState || before.identityState;
  if (!['unverified', 'matched', 'mismatch', 'manual_review'].includes(state)) throw bad('Unknown identity state.');
  const note = optStr(req.body.identityNote != null ? req.body.identityNote : before.identityNote, 'Identity note', { max: 500 });
  if (state !== before.identityState && !note) throw bad('Explain the identity decision in the note.');
  await q(
    `UPDATE uw_parties SET entity_type = ?, legal_name = ?, cin = ?, pan = ?, gstin = ?, aliases = ?, directors = ?, related = ?,
            identity_state = ?, identity_note = ? WHERE id = ?`,
    [p.entityType, p.legalName, p.cin, p.pan, p.gstin, JSON.stringify(p.aliases), JSON.stringify(p.directors), JSON.stringify(p.related), state, note, c.partyId]);
  const after = await uwrepo.getParty(c.partyId);
  await audit.log(req, 'uw.party.update', 'uw_case', c.id, me.name + ' updated borrower identity on ' + c.caseCode, { before, after });
  const ch = await access.changed(c.id, me, 'borrower identity updated');
  return Object.assign({ party: after }, ch);
}));

/* ---------------- proposed terms ---------------- */
function readTerms(b) {
  const p = money.paiseNumber(b.amount, 'INR', 'Proposed amount');
  if (p.error) throw bad(p.error);
  if (p.paise <= 0) throw bad('Proposed amount must be greater than zero.');
  const t = Number(b.tenorDays);
  if (!Number.isInteger(t) || t < 1 || t > 3650) throw bad('Proposed tenor must be a whole number of days between 1 and 3650.');
  let rate = null;
  if (b.ratePct != null && String(b.ratePct).trim() !== '') {
    const d = money.parseDecimal(b.ratePct);
    if (!d || d.neg || d.scale > 4) throw bad('Rate must be a positive number with up to 4 decimals.');
    rate = String(b.ratePct).trim();
  }
  return {
    amountPaise: p.paise, tenorDays: t, ratePct: rate,
    fees: optStr(b.fees, 'Fees', { max: 500 }), security: optStr(b.security, 'Security', { max: 1000 }),
    conditions: optStr(b.conditions, 'Conditions', { max: 4000 }), repayment: optStr(b.repayment, 'Repayment', { max: 1000 })
  };
}

router.put('/cases/:id/terms', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const terms = readTerms(req.body);
  await q('UPDATE uw_cases SET terms = ? WHERE id = ?', [JSON.stringify(terms), c.id]);
  await audit.log(req, 'uw.case.terms', 'uw_case', c.id, me.name + ' set proposed terms on ' + c.caseCode, { before: c.terms, after: terms });
  return { terms };
}));

/* ---------------- readiness, checklist, history ---------------- */
router.get('/cases/:id/readiness', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const r = await readiness.compute(c.id);
  return { ready: r.ready, gates: r.gates, memo: r.memo };
}));

router.get('/cases/:id/checklist', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  return checklist.compute(c);
}));

router.post('/cases/:id/checklist/:itemId/not-applicable', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const itemId = reqId(req.params.itemId, 'Checklist item');
  const reason = reqStr(req.body.reason, 'Reason', { max: 500 });
  const it = await q('SELECT label FROM uw_checklist_items WHERE id = ?', [itemId]);
  if (!it.length) throw bad('Checklist item not found.');
  await q('INSERT INTO uw_checklist_marks (case_id, item_id, reason, set_by_id, set_by) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE reason = VALUES(reason), set_by_id = VALUES(set_by_id), set_by = VALUES(set_by)',
    [c.id, itemId, reason, me.id, me.name]);
  await audit.log(req, 'uw.checklist.na', 'uw_case', c.id, me.name + ' marked "' + it[0].label + '" not applicable', { itemId, reason });
  return access.changed(c.id, me, 'checklist item marked not applicable');
}));

router.delete('/cases/:id/checklist/:itemId/not-applicable', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const itemId = reqId(req.params.itemId, 'Checklist item');
  await q('DELETE FROM uw_checklist_marks WHERE case_id = ? AND item_id = ?', [c.id, itemId]);
  await audit.log(req, 'uw.checklist.na.clear', 'uw_case', c.id, me.name + ' cleared a not-applicable mark', { itemId });
  return access.changed(c.id, me, 'checklist mark cleared');
}));

router.get('/cases/:id/history', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const rows = await q("SELECT * FROM audit_log WHERE entity = 'uw_case' AND entity_id = ? ORDER BY id DESC LIMIT 1000", [String(c.id)]);
  return rows.map(require('../../repo').mapAudit);
}));

router.get('/cases/:id/snapshots/:sid', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const s = await snapshot.get(reqId(req.params.sid, 'Snapshot'), c.id);
  if (!s) throw Object.assign(new Error('Snapshot not found.'), { status: 404 });
  await audit.log(req, 'uw.snapshot.view', 'uw_case', c.id, me.name + ' viewed snapshot r' + s.revision + ' of ' + c.caseCode, { snapshotId: s.id });
  return s;
}));

module.exports = router;
