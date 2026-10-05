'use strict';
/* ============================================================================
   Credit Logic Book and module configuration (spec §5, §7, §9).

   Formulas, reconciliation definitions and policy rules share one lifecycle:
     draft → pending_approval → approved (→ retired by a newer version)
   * Versioned: editing an approved item means creating version n+1.
   * Dual approval: two distinct Managers/Directors. The author's submission
     counts as the first signature when the author holds one of those roles.
   * Rules need a threshold from the credit owner and passing test cases
     before they can be submitted; the developer supplies neither.
   * Approval re-runs every case still being worked; frozen cases keep their
     snapshot.
   ========================================================================== */
const express = require('express');
const { q, tx } = require('../../db/pool');
const audit = require('../../audit');
const money = require('../../uw/money');
const uwrepo = require('../../uw/repo');
const access = require('../../uw/access');
const engine = require('../../uw/engine');
const vocab = require('../../uw/vocab');
const { H, bad, notFound, reqStr, optStr, reqId, oneOf, optDate, flag } = require('../../http');

const router = express.Router();

const KINDS = {
  formulas: { table: 'uw_formulas', type: 'formula', map: uwrepo.mapFormula, noun: 'formula' },
  reconciliations: { table: 'uw_recon_defs', type: 'recon_def', map: uwrepo.mapReconDef, noun: 'reconciliation' },
  rules: { table: 'uw_rules', type: 'rule', map: uwrepo.mapRule, noun: 'policy rule' }
};
const kindOf = (k) => { const x = KINDS[k]; if (!x) throw notFound('Unknown Credit Logic Book section.'); return x; };

async function approvalsFor(type, ids) {
  if (!ids.length) return new Map();
  const rows = await q('SELECT * FROM uw_approvals WHERE object_type = ? AND object_id IN (?) ORDER BY id', [type, ids]);
  const m = new Map();
  rows.forEach((r) => { if (!m.has(r.object_id)) m.set(r.object_id, []); m.get(r.object_id).push(uwrepo.mapApproval(r)); });
  return m;
}

async function listKind(kind, day) {
  const K = KINDS[kind];
  const items = (await q('SELECT * FROM ' + K.table + ' ORDER BY code, version DESC')).map(K.map);
  const ap = await approvalsFor(K.type, items.map((i) => i.id));
  return items.map((i) => Object.assign(i, {
    approvals: ap.get(i.id) || [],
    effectiveNow: engine.effective(i, day),
    tests: kind === 'rules' && i.threshold != null ? engine.runRuleTests(i) : undefined
  }));
}

/* ---------------- overview ---------------- */
router.get('/config', H(async (req) => {
  access.requireMaker(req);
  const [fields, products, checklist, sources, bankRules, settings] = await Promise.all([
    q('SELECT * FROM uw_field_codes ORDER BY category, label'),
    q('SELECT * FROM uw_products ORDER BY label'),
    q('SELECT * FROM uw_checklist_items ORDER BY sort_order, id'),
    q('SELECT * FROM uw_sources ORDER BY name'),
    q('SELECT * FROM uw_bank_rules ORDER BY priority, id'),
    q('SELECT * FROM uw_settings')
  ]);
  const day = await engine.dbToday();
  return {
    today: day,
    formulas: await listKind('formulas', day),
    reconciliations: await listKind('reconciliations', day),
    rules: await listKind('rules', day),
    fieldCodes: fields.map(uwrepo.mapFieldCode),
    products: products.map((p) => ({ key: p.product_key, label: p.label, active: !!p.active })),
    checklist: checklist.map((r) => ({
      id: r.id, product: r.product, key: r.item_key, label: r.label, docType: r.doc_type, mandatory: !!r.mandatory,
      minVintageYears: r.min_vintage_years == null ? null : Number(r.min_vintage_years), periodRule: r.period_rule,
      periodsRequired: r.periods_required, auditedOnly: !!r.audited_only, sortOrder: r.sort_order, active: !!r.active
    })),
    sources: sources.map(uwrepo.mapSource),
    bankRules: bankRules.map(uwrepo.mapBankRule),
    settings: Object.fromEntries(settings.map((s) => [s.setting_key, uwrepo.j(s.value)])),
    formats: engine.FORMATS
  };
}));

/* ---------------- read a book item from the request ---------------- */
async function readItem(kind, b) {
  const fields = await engine.loadFields();
  const out = { label: reqStr(b.label, 'Label', { max: 190 }), notes: optStr(b.notes, 'Notes', { max: 4000 }), effectiveFrom: optDate(b.effectiveFrom, 'Effective from') };
  try {
    if (kind === 'formulas') out.definition = engine.validateFormulaDef(b.definition, fields);
    if (kind === 'reconciliations') {
      out.definition = engine.validateReconDef(b.definition, fields);
      out.controlArea = oneOf(b.controlArea, 'Control area', vocab.CONTROL_AREAS);
      out.tolerancePct = null; out.toleranceAbsPaise = null;
      if (b.tolerancePct != null && String(b.tolerancePct).trim() !== '') {
        const d = money.parseDecimal(b.tolerancePct);
        if (!d || d.neg || d.scale > 4) throw new Error('Percentage tolerance must be a non-negative number with up to 4 decimals.');
        out.tolerancePct = String(b.tolerancePct).trim();
      }
      if (b.toleranceAbs != null && String(b.toleranceAbs).trim() !== '') {
        const p = money.paiseNumber(b.toleranceAbs, 'INR', 'Amount tolerance');
        if (p.error) throw new Error(p.error);
        if (p.paise < 0) throw new Error('Amount tolerance cannot be negative.');
        out.toleranceAbsPaise = p.paise;
      }
    }
    if (kind === 'rules') {
      out.ruleClass = oneOf(b.ruleClass, 'Rule class', vocab.RULE_CLASSES);
      out.operator = b.operator;
      out.metric = String(b.metric || '').trim();
      out.threshold = b.threshold === '' || b.threshold === undefined ? null : b.threshold;
      if (typeof out.threshold === 'number') out.threshold = String(out.threshold);
      out.testCases = Array.isArray(b.testCases) ? b.testCases.map((t) => ({ label: String(t.label || '').slice(0, 120), value: t.value == null ? '' : String(t.value).slice(0, 120), expected: t.expected })) : [];
      out.products = Array.isArray(b.products) && b.products.length ? b.products.map(String) : null;
      out.overridable = flag(b.overridable);
      out.effectiveTo = optDate(b.effectiveTo, 'Effective to');
      if (out.effectiveFrom && out.effectiveTo && out.effectiveTo < out.effectiveFrom) throw new Error('Effective-to is before effective-from.');
      if (out.overridable && out.ruleClass !== 'hard_stop') throw new Error('Only hard stops can be marked overridable.');
      engine.validateRule(out);
    }
  } catch (e) { throw bad(e.message); }
  return out;
}

function colsFor(kind, it) {
  if (kind === 'formulas') return { label: it.label, definition: JSON.stringify(it.definition), notes: it.notes, effective_from: it.effectiveFrom };
  if (kind === 'reconciliations') {
    return { label: it.label, control_area: it.controlArea, definition: JSON.stringify(it.definition), tolerance_pct: it.tolerancePct,
      tolerance_abs_paise: it.toleranceAbsPaise, notes: it.notes, effective_from: it.effectiveFrom };
  }
  return { label: it.label, rule_class: it.ruleClass, metric: it.metric, operator: it.operator,
    threshold: it.threshold == null ? null : JSON.stringify(it.threshold), products: it.products ? JSON.stringify(it.products) : null,
    overridable: it.overridable ? 1 : 0, test_cases: JSON.stringify(it.testCases), notes: it.notes,
    effective_from: it.effectiveFrom, effective_to: it.effectiveTo };
}

/* Dry-run a rule's test cases without saving. */
router.post('/config/rules-test', H(async (req) => {
  access.requireBookEditor(req);
  try { engine.validateRule(req.body); } catch (e) { throw bad(e.message); }
  return engine.runRuleTests({ operator: req.body.operator, threshold: req.body.threshold, testCases: req.body.testCases || [] });
}));

/* ---------------- create a draft (new code, or next version of a code) ---------------- */
router.post('/config/:kind', H(async (req) => {
  const me = access.requireBookEditor(req);
  const kind = req.params.kind; const K = kindOf(kind);
  const code = reqStr(req.body.code, 'Code', { max: 64 }).toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(code)) throw bad('Code must be lower-case letters, digits and underscores, starting with a letter.');
  const open = await q('SELECT id FROM ' + K.table + " WHERE code = ? AND status IN ('draft','pending_approval')", [code]);
  if (open.length) throw bad('There is already an unapproved version of "' + code + '" — edit that one.');
  const it = await readItem(kind, req.body);
  const [{ v }] = await q('SELECT COALESCE(MAX(version), 0) AS v FROM ' + K.table + ' WHERE code = ?', [code]);
  const cols = Object.assign({ code, version: Number(v) + 1, status: 'draft', created_by_id: me.id, created_by: me.name }, colsFor(kind, it));
  const keys = Object.keys(cols);
  const r = await q('INSERT INTO ' + K.table + ' (' + keys.join(', ') + ') VALUES (' + keys.map(() => '?').join(', ') + ')', keys.map((k) => cols[k]));
  await audit.log(req, 'uw.book.' + K.type + '.create', 'uw_book', K.type + ':' + r.insertId, me.name + ' drafted ' + K.noun + ' ' + code + ' v' + cols.version, { after: it });
  return K.map((await q('SELECT * FROM ' + K.table + ' WHERE id = ?', [r.insertId]))[0]);
}));

async function loadItem(kind, id) {
  const K = kindOf(kind);
  const rows = await q('SELECT * FROM ' + K.table + ' WHERE id = ?', [id]);
  if (!rows.length) throw notFound('Not found.');
  return K.map(rows[0]);
}

router.put('/config/:kind/:id', H(async (req) => {
  const me = access.requireBookEditor(req);
  const kind = req.params.kind; const K = kindOf(kind);
  const before = await loadItem(kind, reqId(req.params.id, 'Item'));
  if (before.status !== 'draft') throw bad('Only a draft can be edited. Create a new version of an approved ' + K.noun + '.');
  // The amount tolerance is stored in paise but read in rupees.
  const base = Object.assign({}, before, { toleranceAbs: before.toleranceAbsPaise == null ? null : money.paiseToRupeeString(before.toleranceAbsPaise) });
  const it = await readItem(kind, Object.assign(base, req.body));
  const cols = colsFor(kind, it);
  await q('UPDATE ' + K.table + ' SET ' + Object.keys(cols).map((k) => k + ' = ?').join(', ') + ' WHERE id = ?', Object.values(cols).concat([before.id]));
  const after = await loadItem(kind, before.id);
  await audit.log(req, 'uw.book.' + K.type + '.edit', 'uw_book', K.type + ':' + before.id, me.name + ' edited ' + K.noun + ' ' + before.code + ' v' + before.version, { before, after });
  return after;
}));

router.delete('/config/:kind/:id', H(async (req) => {
  const me = access.requireBookEditor(req);
  const kind = req.params.kind; const K = kindOf(kind);
  const it = await loadItem(kind, reqId(req.params.id, 'Item'));
  if (it.status !== 'draft') throw bad('Only a draft can be deleted.');
  await q('DELETE FROM ' + K.table + ' WHERE id = ?', [it.id]);
  await q('DELETE FROM uw_approvals WHERE object_type = ? AND object_id = ?', [K.type, it.id]);
  await audit.log(req, 'uw.book.' + K.type + '.delete', 'uw_book', K.type + ':' + it.id, me.name + ' deleted draft ' + K.noun + ' ' + it.code + ' v' + it.version, { before: it });
  return { ok: true };
}));

/* draft → pending_approval */
router.post('/config/:kind/:id/submit', H(async (req) => {
  const me = access.requireBookEditor(req);
  const kind = req.params.kind; const K = kindOf(kind);
  const it = await loadItem(kind, reqId(req.params.id, 'Item'));
  if (it.status !== 'draft') throw bad('Only a draft can be submitted for approval.');
  if (kind === 'rules') {
    if (it.threshold == null) throw bad('The credit owner must supply the threshold before this rule can be approved.');
    if (!it.testCases.length) throw bad('Add at least one test case.');
    const results = engine.runRuleTests(it);
    const failed = results.filter((t) => !t.pass);
    if (failed.length) throw bad(failed.length + ' test case(s) fail: ' + failed.map((t) => (t.label || t.value) + ' expected ' + t.expected + ', got ' + t.actual).join('; '));
  }
  await tx(async (cx) => {
    await cx.q('UPDATE ' + K.table + " SET status = 'pending_approval' WHERE id = ?", [it.id]);
    await cx.q('DELETE FROM uw_approvals WHERE object_type = ? AND object_id = ?', [K.type, it.id]);
    // The author's submission is the first of the two signatures.
    await cx.q('INSERT INTO uw_approvals (object_type, object_id, approver_id, approver_name, approver_role, note) VALUES (?,?,?,?,?,?)',
      [K.type, it.id, me.id, me.name, me.role, 'Submitted for approval']);
  });
  await audit.log(req, 'uw.book.' + K.type + '.submit', 'uw_book', K.type + ':' + it.id, me.name + ' submitted ' + K.noun + ' ' + it.code + ' v' + it.version + ' for approval');
  return loadItem(kind, it.id);
}));

router.post('/config/:kind/:id/approve', H(async (req) => {
  const me = access.requireBookEditor(req);
  const kind = req.params.kind; const K = kindOf(kind);
  const it = await loadItem(kind, reqId(req.params.id, 'Item'));
  if (it.status !== 'pending_approval') throw bad('Only an item pending approval can be approved.');
  const note = optStr(req.body.note, 'Note', { max: 500 });
  let became = false;
  await tx(async (cx) => {
    const [row] = await cx.q('SELECT status FROM ' + K.table + ' WHERE id = ? FOR UPDATE', [it.id]);
    if (row.status !== 'pending_approval') throw bad('This item changed state — reload.');
    const prior = await cx.q('SELECT approver_id FROM uw_approvals WHERE object_type = ? AND object_id = ?', [K.type, it.id]);
    if (prior.some((p) => p.approver_id === me.id)) throw bad('You have already signed this ' + K.noun + ' — a second, different person must approve it.');
    await cx.q('INSERT INTO uw_approvals (object_type, object_id, approver_id, approver_name, approver_role, note) VALUES (?,?,?,?,?,?)',
      [K.type, it.id, me.id, me.name, me.role, note]);
    if (prior.length + 1 >= 2) {
      became = true;
      await cx.q('UPDATE ' + K.table + " SET status = 'approved', effective_from = COALESCE(effective_from, CURDATE()) WHERE id = ?", [it.id]);
      // The previous approved version of the same code is superseded.
      await cx.q('UPDATE ' + K.table + " SET status = 'retired' WHERE code = ? AND id <> ? AND status = 'approved'", [it.code, it.id]);
    }
  });
  await audit.log(req, 'uw.book.' + K.type + '.approve', 'uw_book', K.type + ':' + it.id,
    me.name + ' approved ' + K.noun + ' ' + it.code + ' v' + it.version + (became ? ' — now in force' : ' — awaiting a second approver'), { note });
  let rerun = 0;
  if (became) rerun = await access.rerunOpenCases(me, K.noun + ' ' + it.code + ' v' + it.version + ' approved');
  return Object.assign(await loadItem(kind, it.id), { approvedNow: became, casesRerun: rerun });
}));

router.post('/config/:kind/:id/reject', H(async (req) => {
  const me = access.requireBookEditor(req);
  const kind = req.params.kind; const K = kindOf(kind);
  const it = await loadItem(kind, reqId(req.params.id, 'Item'));
  if (it.status !== 'pending_approval') throw bad('Only an item pending approval can be sent back.');
  const note = reqStr(req.body.note, 'Reason', { max: 500 });
  await tx(async (cx) => {
    await cx.q('UPDATE ' + K.table + " SET status = 'draft' WHERE id = ?", [it.id]);
    await cx.q('DELETE FROM uw_approvals WHERE object_type = ? AND object_id = ?', [K.type, it.id]);
  });
  await audit.log(req, 'uw.book.' + K.type + '.reject', 'uw_book', K.type + ':' + it.id, me.name + ' sent ' + K.noun + ' ' + it.code + ' v' + it.version + ' back to draft', { note });
  return loadItem(kind, it.id);
}));

router.post('/config/:kind/:id/retire', H(async (req) => {
  const me = access.requireDirector(req);
  const kind = req.params.kind; const K = kindOf(kind);
  const it = await loadItem(kind, reqId(req.params.id, 'Item'));
  if (it.status !== 'approved') throw bad('Only an approved item can be retired.');
  const note = reqStr(req.body.note, 'Reason', { max: 500 });
  await q('UPDATE ' + K.table + " SET status = 'retired' WHERE id = ?", [it.id]);
  await audit.log(req, 'uw.book.' + K.type + '.retire', 'uw_book', K.type + ':' + it.id, me.name + ' retired ' + K.noun + ' ' + it.code + ' v' + it.version, { note });
  const rerun = await access.rerunOpenCases(me, K.noun + ' ' + it.code + ' retired');
  return Object.assign(await loadItem(kind, it.id), { casesRerun: rerun });
}));

/* ---------------- field codes ---------------- */
router.post('/config-fields', H(async (req) => {
  const me = access.requireBookEditor(req);
  const code = reqStr(req.body.code, 'Code', { max: 64 }).toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(code)) throw bad('Code must be lower-case letters, digits and underscores.');
  const valueType = oneOf(req.body.valueType, 'Value type', vocab.VALUE_TYPES);
  const periodKind = oneOf(req.body.periodKind, 'Period kind', vocab.PERIOD_KINDS);
  if (!['money', 'number', 'percent'].includes(valueType) && periodKind !== 'none') throw bad('Text and date fields have no period kind — use "none".');
  if ((await q('SELECT code FROM uw_field_codes WHERE code = ?', [code])).length) throw bad('That field code exists.');
  await q('INSERT INTO uw_field_codes (code, label, value_type, period_kind, category, description) VALUES (?,?,?,?,?,?)',
    [code, reqStr(req.body.label, 'Label'), valueType, periodKind, optStr(req.body.category, 'Category', { max: 48 }) || 'other', optStr(req.body.description, 'Description', { max: 500 })]);
  await audit.log(req, 'uw.field.create', 'uw_book', 'field:' + code, me.name + ' added field code ' + code, { valueType, periodKind });
  return { ok: true };
}));

router.put('/config-fields/:code', H(async (req) => {
  const me = access.requireBookEditor(req);
  const rows = await q('SELECT * FROM uw_field_codes WHERE code = ?', [req.params.code]);
  if (!rows.length) throw notFound('Field code not found.');
  // Type and period kind are fixed once defined: facts and formulas rely on them.
  const label = req.body.label != null ? reqStr(req.body.label, 'Label') : rows[0].label;
  const active = req.body.active != null ? (flag(req.body.active) ? 1 : 0) : rows[0].active;
  await q('UPDATE uw_field_codes SET label = ?, active = ?, description = ? WHERE code = ?',
    [label, active, req.body.description != null ? optStr(req.body.description, 'Description', { max: 500 }) : rows[0].description, rows[0].code]);
  await audit.log(req, 'uw.field.update', 'uw_book', 'field:' + rows[0].code, me.name + ' updated field code ' + rows[0].code, { before: uwrepo.mapFieldCode(rows[0]), label, active: !!active });
  return { ok: true };
}));

/* ---------------- products and checklist ---------------- */
router.post('/config-products', H(async (req) => {
  const me = access.requireBookEditor(req);
  const key = reqStr(req.body.key, 'Product key', { max: 40 }).toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) throw bad('Product key must be lower-case letters, digits and underscores.');
  await q('INSERT INTO uw_products (product_key, label, active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE label = VALUES(label), active = 1',
    [key, reqStr(req.body.label, 'Label', { max: 120 })]);
  await audit.log(req, 'uw.product.save', 'uw_book', 'product:' + key, me.name + ' saved product ' + key);
  return { ok: true };
}));

function readChecklistItem(b) {
  const periodRule = oneOf(b.periodRule, 'Period rule', ['none', 'annual', 'monthly'], 'none');
  let periods = null;
  if (periodRule !== 'none') {
    periods = Number(b.periodsRequired);
    if (!Number.isInteger(periods) || periods < 1 || periods > (periodRule === 'annual' ? 10 : 36)) throw bad('Periods required must be a whole number (1–10 years or 1–36 months).');
  }
  let minV = null;
  if (b.minVintageYears != null && b.minVintageYears !== '') {
    minV = Number(b.minVintageYears);
    if (!(minV >= 0 && minV <= 200)) throw bad('Minimum vintage must be between 0 and 200 years.');
  }
  return {
    product: b.product ? String(b.product) : null,
    key: reqStr(b.key, 'Item key', { max: 48 }), label: reqStr(b.label, 'Label'),
    docType: oneOf(b.docType, 'Document type', vocab.DOC_TYPE_KEYS.filter((k) => k !== 'unclassified')),
    mandatory: b.mandatory == null ? true : flag(b.mandatory), minVintageYears: minV, periodRule, periodsRequired: periods,
    auditedOnly: flag(b.auditedOnly), sortOrder: Number.isInteger(Number(b.sortOrder)) ? Number(b.sortOrder) : 0
  };
}

router.post('/config-checklist', H(async (req) => {
  const me = access.requireBookEditor(req);
  const it = readChecklistItem(req.body);
  if (it.product && !(await q('SELECT product_key FROM uw_products WHERE product_key = ?', [it.product])).length) throw bad('Unknown product.');
  const dupe = await q('SELECT id FROM uw_checklist_items WHERE item_key = ? AND product <=> ?', [it.key, it.product]);
  if (dupe.length) throw bad('That item key already exists for this product.');
  const r = await q(`INSERT INTO uw_checklist_items (product, item_key, label, doc_type, mandatory, min_vintage_years, period_rule, periods_required, audited_only, sort_order)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [it.product, it.key, it.label, it.docType, it.mandatory ? 1 : 0, it.minVintageYears, it.periodRule, it.periodsRequired, it.auditedOnly ? 1 : 0, it.sortOrder]);
  await audit.log(req, 'uw.checklist.create', 'uw_book', 'checklist:' + r.insertId, me.name + ' added checklist item "' + it.label + '"', it);
  await access.rerunOpenCases(me, 'checklist changed');
  return { ok: true, id: r.insertId };
}));

router.put('/config-checklist/:id', H(async (req) => {
  const me = access.requireBookEditor(req);
  const id = reqId(req.params.id, 'Checklist item');
  const rows = await q('SELECT * FROM uw_checklist_items WHERE id = ?', [id]);
  if (!rows.length) throw notFound('Checklist item not found.');
  const r = rows[0];
  const it = readChecklistItem(Object.assign({
    product: r.product, key: r.item_key, label: r.label, docType: r.doc_type, mandatory: !!r.mandatory, minVintageYears: r.min_vintage_years,
    periodRule: r.period_rule, periodsRequired: r.periods_required, auditedOnly: !!r.audited_only, sortOrder: r.sort_order
  }, req.body));
  const active = req.body.active != null ? (flag(req.body.active) ? 1 : 0) : r.active;
  await q(`UPDATE uw_checklist_items SET label = ?, doc_type = ?, mandatory = ?, min_vintage_years = ?, period_rule = ?, periods_required = ?,
                 audited_only = ?, sort_order = ?, active = ? WHERE id = ?`,
  [it.label, it.docType, it.mandatory ? 1 : 0, it.minVintageYears, it.periodRule, it.periodsRequired, it.auditedOnly ? 1 : 0, it.sortOrder, active, id]);
  await audit.log(req, 'uw.checklist.update', 'uw_book', 'checklist:' + id, me.name + ' updated checklist item "' + it.label + '"', { before: r, after: Object.assign(it, { active: !!active }) });
  await access.rerunOpenCases(me, 'checklist changed');
  return { ok: true };
}));

/* ---------------- public source registry ---------------- */
function readSource(b) {
  const url = optStr(b.url, 'URL', { max: 500 });
  if (url && !/^https?:\/\//i.test(url)) throw bad('URL must start with http:// or https://.');
  const accessMethod = oneOf(b.accessMethod, 'Access method', ['manual', 'automated'], 'manual');
  const permitted = flag(b.automatedUsePermitted);
  if (accessMethod === 'automated' && !permitted) throw bad('Automated access needs "automated use permitted" confirmed after checking the site\'s terms.');
  return {
    name: reqStr(b.name, 'Name'), jurisdiction: optStr(b.jurisdiction, 'Jurisdiction', { max: 80 }) || 'India', url,
    searchIdentifiers: optStr(b.searchIdentifiers, 'Search identifiers', { max: 255 }), accessMethod, permitted,
    owner: optStr(b.owner, 'Owner', { max: 120 }), refreshDate: optDate(b.refreshDate, 'Refresh date'),
    fallback: optStr(b.fallback, 'Fallback', { max: 500 }), notes: optStr(b.notes, 'Notes', { max: 1000 }),
    active: b.active == null ? true : flag(b.active)
  };
}

router.post('/config-sources', H(async (req) => {
  const me = access.requireBookEditor(req);
  const s = readSource(req.body);
  const r = await q(`INSERT INTO uw_sources (name, jurisdiction, url, search_identifiers, access_method, automated_use_permitted, owner, refresh_date, fallback, notes, active)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [s.name, s.jurisdiction, s.url, s.searchIdentifiers, s.accessMethod, s.permitted ? 1 : 0, s.owner, s.refreshDate, s.fallback, s.notes, s.active ? 1 : 0]);
  await audit.log(req, 'uw.source.create', 'uw_book', 'source:' + r.insertId, me.name + ' added public source ' + s.name, s);
  return { ok: true, id: r.insertId };
}));

router.put('/config-sources/:id', H(async (req) => {
  const me = access.requireBookEditor(req);
  const id = reqId(req.params.id, 'Source');
  const rows = await q('SELECT * FROM uw_sources WHERE id = ?', [id]);
  if (!rows.length) throw notFound('Source not found.');
  const before = uwrepo.mapSource(rows[0]);
  const s = readSource(Object.assign({}, before, req.body));
  await q(`UPDATE uw_sources SET name = ?, jurisdiction = ?, url = ?, search_identifiers = ?, access_method = ?, automated_use_permitted = ?,
                 owner = ?, refresh_date = ?, fallback = ?, notes = ?, active = ? WHERE id = ?`,
  [s.name, s.jurisdiction, s.url, s.searchIdentifiers, s.accessMethod, s.permitted ? 1 : 0, s.owner, s.refreshDate, s.fallback, s.notes, s.active ? 1 : 0, id]);
  await audit.log(req, 'uw.source.update', 'uw_book', 'source:' + id, me.name + ' updated public source ' + s.name, { before, after: s });
  return { ok: true };
}));

/* ---------------- bank classification rules ---------------- */
function readBankRule(b) {
  const direction = oneOf(b.direction, 'Direction', ['credit', 'debit', 'any'], 'any');
  const allowed = direction === 'credit' ? vocab.CREDIT_CATEGORIES : direction === 'debit' ? vocab.DEBIT_CATEGORIES
    : vocab.CREDIT_CATEGORIES.filter((x) => vocab.DEBIT_CATEGORIES.includes(x));
  const category = oneOf(b.category, 'Category', allowed);
  const priority = Number(b.priority == null || b.priority === '' ? 100 : b.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 10000) throw bad('Priority must be a whole number from 0 to 10000.');
  return {
    pattern: reqStr(b.pattern, 'Narration contains', { max: 120, min: 3 }), direction, category, setsReturn: flag(b.setsReturn),
    counterparty: optStr(b.counterparty, 'Counterparty', { max: 190 }), priority, active: b.active == null ? true : flag(b.active)
  };
}

router.post('/config-bank-rules', H(async (req) => {
  const me = access.requireBookEditor(req);
  const r = readBankRule(req.body);
  const ins = await q('INSERT INTO uw_bank_rules (pattern, direction, category, sets_return, counterparty, priority, active, created_by) VALUES (?,?,?,?,?,?,?,?)',
    [r.pattern, r.direction, r.category, r.setsReturn ? 1 : 0, r.counterparty, r.priority, r.active ? 1 : 0, me.name]);
  await audit.log(req, 'uw.bankrule.create', 'uw_book', 'bankrule:' + ins.insertId, me.name + ' added bank rule "' + r.pattern + '" → ' + r.category, r);
  const n = await access.rerunOpenCases(me, 'bank rules changed', { reclassifyBank: true });
  return { ok: true, id: ins.insertId, casesRerun: n };
}));

router.put('/config-bank-rules/:id', H(async (req) => {
  const me = access.requireBookEditor(req);
  const id = reqId(req.params.id, 'Bank rule');
  const rows = await q('SELECT * FROM uw_bank_rules WHERE id = ?', [id]);
  if (!rows.length) throw notFound('Bank rule not found.');
  const before = uwrepo.mapBankRule(rows[0]);
  const r = readBankRule(Object.assign({}, before, req.body));
  await q('UPDATE uw_bank_rules SET pattern = ?, direction = ?, category = ?, sets_return = ?, counterparty = ?, priority = ?, active = ? WHERE id = ?',
    [r.pattern, r.direction, r.category, r.setsReturn ? 1 : 0, r.counterparty, r.priority, r.active ? 1 : 0, id]);
  await audit.log(req, 'uw.bankrule.update', 'uw_book', 'bankrule:' + id, me.name + ' updated bank rule "' + r.pattern + '"', { before, after: r });
  const n = await access.rerunOpenCases(me, 'bank rules changed', { reclassifyBank: true });
  return { ok: true, casesRerun: n };
}));

/* ---------------- settings (Director) ---------------- */
router.put('/config-settings', H(async (req) => {
  const me = access.requireDirector(req);
  const before = Object.fromEntries((await q('SELECT * FROM uw_settings')).map((s) => [s.setting_key, uwrepo.j(s.value)]));
  const next = {};
  if (req.body.transferMatchDays !== undefined) {
    const d = Number(req.body.transferMatchDays);
    if (!Number.isInteger(d) || d < 0 || d > 10) throw bad('Transfer matching window must be 0–10 days.');
    next.transfer_match_days = d;
  }
  if (req.body.bankReviewThreshold !== undefined) {
    if (req.body.bankReviewThreshold === null || String(req.body.bankReviewThreshold).trim() === '') next.bank_review_threshold_paise = null;
    else {
      const p = money.paiseNumber(req.body.bankReviewThreshold, 'INR', 'Review threshold');
      if (p.error) throw bad(p.error);
      if (p.paise < 0) throw bad('Review threshold cannot be negative.');
      next.bank_review_threshold_paise = p.paise;
    }
  }
  for (const [k, v] of Object.entries(next)) {
    await q('INSERT INTO uw_settings (setting_key, value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)',
      [k, JSON.stringify(v), me.name]);
  }
  await audit.log(req, 'uw.settings', 'uw_book', 'settings', me.name + ' changed underwriting settings', { before, after: next });
  const n = await access.rerunOpenCases(me, 'settings changed', { reclassifyBank: 'transfer_match_days' in next });
  return { ok: true, casesRerun: n };
}));

module.exports = router;
