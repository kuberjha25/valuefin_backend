'use strict';
/* ============================================================================
   Typed facts with provenance (spec §2.4, §3).

   * Every fact cites its source: a document version plus a page, a cell, an
     extracted line/cell, or a bank transaction.
   * When the source is an extracted spreadsheet cell, the value is read from
     the cell itself. When it is an extracted PDF line, the stated value must
     literally appear on that line. A number that is not in the evidence
     cannot become a fact.
   * A fact is never edited. A correction creates a new fact that supersedes
     it, with the actor, the reason and the time.
   ========================================================================== */
const { q, tx } = require('../db/pool');
const money = require('./money');
const uwrepo = require('./repo');
const { BASES } = require('./vocab');

const bad = (m) => Object.assign(new Error(m), { status: 400 });
/* Server-side timestamp, so every audit time comes from the same clock. */
const NOW = { toSqlString: () => 'NOW(3)' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validIso = (s) => ISO.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime()) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

const FACT_SELECT = `SELECT f.*, CAST(f.value_num AS CHAR) AS value_num_str, fc.label AS field_label,
       v.original_name AS source_name
  FROM uw_facts f
  JOIN uw_field_codes fc ON fc.code = f.field_code
  LEFT JOIN uw_document_versions v ON v.id = f.source_version_id`;
const mapRow = (r) => Object.assign(uwrepo.mapFact(r), { valueNum: r.value_num_str });

async function list(caseId, { all = false } = {}) {
  const rows = await q(FACT_SELECT + ' WHERE f.case_id = ?' + (all ? '' : ' AND f.is_current = 1') + ' ORDER BY f.field_code, f.period_end, f.id', [caseId]);
  return rows.map(mapRow);
}
async function get(id) {
  const rows = await q(FACT_SELECT + ' WHERE f.id = ?', [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

const compact = (s) => String(s || '').replace(/[\s,   ]/g, '');

/* Resolve and check the source reference. Returns the columns to store. */
async function resolveSource(caseId, input) {
  const out = { source_version_id: null, source_unit_id: null, source_page: null, source_cell: null, source_txn_id: null, unit: null };
  if (input.sourceTxnId) {
    const t = await q('SELECT id, version_id, sheet, row_index FROM uw_transactions WHERE id = ? AND case_id = ?', [input.sourceTxnId, caseId]);
    if (!t.length) throw bad('That bank transaction is not on this case.');
    out.source_txn_id = t[0].id;
    out.source_version_id = t[0].version_id;
    out.source_cell = (t[0].sheet ? t[0].sheet + '!' : '') + 'row ' + t[0].row_index;
    return out;
  }
  if (!input.sourceVersionId) throw bad('Cite the source document version.');
  const v = await q('SELECT id, case_id, intake_status, page_count, detected_type FROM uw_document_versions WHERE id = ?', [input.sourceVersionId]);
  if (!v.length || v[0].case_id !== caseId) throw bad('That document version is not on this case.');
  if (v[0].intake_status !== 'accepted') throw bad('Cite an accepted document version (this one is ' + v[0].intake_status + ').');
  out.source_version_id = v[0].id;

  if (input.sourceUnitId) {
    const u = await q('SELECT * FROM uw_evidence_units WHERE id = ? AND version_id = ?', [input.sourceUnitId, v[0].id]);
    if (!u.length) throw bad('That extracted line/cell does not belong to the cited document.');
    out.source_unit_id = u[0].id;
    out.unit = u[0];
    if (u[0].kind === 'line') out.source_page = u[0].page;
    else out.source_cell = u[0].sheet + '!' + u[0].cell_ref;
  }
  if (input.sourcePage != null && input.sourcePage !== '') {
    const p = Number(input.sourcePage);
    if (!Number.isInteger(p) || p < 1 || (v[0].page_count && p > v[0].page_count)) throw bad('Page must be between 1 and ' + (v[0].page_count || 'the page count') + '.');
    if (out.source_page && out.source_page !== p) throw bad('The page does not match the cited line.');
    out.source_page = p;
  }
  if (input.sourceCell && !out.source_cell) out.source_cell = String(input.sourceCell).trim().slice(0, 140);
  if (!out.source_unit_id && !out.source_page && !out.source_cell) throw bad('Give the page, the cell or the extracted line the value comes from.');
  return out;
}

/* Turn the input into typed value columns, checked against the evidence. */
function typedValue(field, input, unit) {
  const cols = { amount_paise: null, value_num: null, value_text: null, value_date: null, currency: null, original_unit: '', raw_value: '' };
  let raw = input.rawValue == null ? '' : String(input.rawValue).trim();

  if (unit && unit.kind === 'cell') {
    const cellText = unit.text == null ? '' : String(unit.text);
    if (!raw) raw = cellText;
    else if (field.valueType === 'money' || field.valueType === 'number' || field.valueType === 'percent') {
      const a = money.toMicro(raw), b = money.toMicro(cellText);
      if (a == null || b == null || a !== b) throw bad('The value "' + raw + '" differs from cell ' + unit.sheet + '!' + unit.cell_ref + ' ("' + cellText + '"). Facts from a cell take the cell\'s value; change the unit if it is in lakhs/crores.');
    } else if (raw !== cellText) {
      throw bad('The value differs from cell ' + unit.sheet + '!' + unit.cell_ref + '.');
    }
  } else if (unit && unit.kind === 'line') {
    if (!raw) throw bad('Enter the value as printed on the line.');
    if (!compact(unit.text).includes(compact(raw))) throw bad('"' + raw + '" does not appear on the cited line (page ' + unit.page + '): "' + String(unit.text).slice(0, 160) + '".');
  }
  if (!raw) throw bad('Enter the value.');
  cols.raw_value = raw.slice(0, 255);

  switch (field.valueType) {
    case 'money': {
      const u = input.unit || 'INR';
      if (!money.UNITS.includes(u)) throw bad('Unit must be one of: ' + money.UNITS.join(', ') + '.');
      const p = money.paiseNumber(raw, u, field.label);
      if (p.error) throw bad(p.error);
      cols.amount_paise = p.paise; cols.currency = 'INR'; cols.original_unit = u;
      break;
    }
    case 'number': case 'percent': {
      const d = money.parseDecimal(raw.replace(/%$/, ''));
      if (!d) throw bad(field.label + ' "' + raw + '" is not a number.');
      if (d.scale > 6) throw bad(field.label + ' has more than 6 decimal places.');
      cols.value_num = (d.neg ? '-' : '') + money.fixedToString(d.digits, d.scale);
      cols.original_unit = field.valueType === 'percent' ? 'percent' : '';
      break;
    }
    case 'date':
      if (!validIso(raw)) throw bad(field.label + ' must be a date (YYYY-MM-DD).');
      cols.value_date = raw;
      break;
    default:
      cols.value_text = raw.slice(0, 1000);
  }
  return cols;
}

function periodCols(field, input) {
  const s = input.periodStart || null, e = input.periodEnd || null;
  if (s && !validIso(s)) throw bad('Period start must be a date (YYYY-MM-DD).');
  if (e && !validIso(e)) throw bad('Period end must be a date (YYYY-MM-DD).');
  if (field.periodKind === 'flow') {
    if (!s || !e) throw bad(field.label + ' is a period figure: give the period start and end.');
    if (s > e) throw bad('Period start is after period end.');
    return { period_start: s, period_end: e };
  }
  if (field.periodKind === 'stock') {
    if (!e) throw bad(field.label + ' is a balance: give the "as at" date (period end).');
    return { period_start: null, period_end: e };
  }
  return { period_start: null, period_end: e };
}

async function build(caseId, input) {
  const fRows = await q('SELECT * FROM uw_field_codes WHERE code = ? AND active = 1', [input.fieldCode]);
  if (!fRows.length) throw bad('Unknown or inactive field code.');
  const field = uwrepo.mapFieldCode(fRows[0]);
  if (!BASES.includes(input.basis)) throw bad('Basis must be one of: ' + BASES.join(', ') + '.');
  const src = await resolveSource(caseId, input);
  const val = typedValue(field, input, src.unit);
  const per = periodCols(field, input);
  let confidence = null;
  if (input.confidence != null && input.confidence !== '') {
    confidence = Number(input.confidence);
    if (!(confidence >= 0 && confidence <= 1)) throw bad('Confidence must be between 0 and 1.');
  }
  return {
    field, cols: Object.assign({ field_code: field.code, value_type: field.valueType, basis: input.basis, confidence,
      source_note: String(input.sourceNote || '').slice(0, 500) }, val, per,
    { source_version_id: src.source_version_id, source_unit_id: src.source_unit_id, source_page: src.source_page,
      source_cell: src.source_cell, source_txn_id: src.source_txn_id })
  };
}

async function insert(cx, caseId, cols, extra) {
  const all = Object.assign({ case_id: caseId }, cols, extra);
  const keys = Object.keys(all);
  const r = await cx.q('INSERT INTO uw_facts (' + keys.join(', ') + ') VALUES (' + keys.map(() => '?').join(', ') + ')', keys.map((k) => all[k]));
  return r.insertId;
}

/* Analyst-recorded fact. The analyst states whether it is reviewed
   (approved) or provisional. */
async function create(caseId, input, user) {
  const status = input.reviewStatus === 'provisional' ? 'provisional' : 'approved';
  const { cols } = await build(caseId, input);
  const id = await tx((cx) => insert(cx, caseId, cols, {
    origin: input.origin === 'spreadsheet' ? 'spreadsheet' : 'analyst', review_status: status,
    created_by_id: user.id, created_by: user.name,
    reviewed_by_id: user.id, reviewed_by: user.name, reviewed_at: NOW
  }));
  return get(id);
}

/* Supersede: never overwrite the old value. */
async function correct(caseId, factId, input, user) {
  const reason = String(input.reason || '').trim();
  if (!reason) throw bad('A reason is required to correct a fact.');
  const old = await get(factId);
  if (!old || old.caseId !== caseId) throw Object.assign(new Error('Fact not found.'), { status: 404 });
  if (!old.isCurrent) throw bad('This fact was already superseded by #' + old.supersededById + '.');
  const merged = {
    fieldCode: old.fieldCode,
    // A new source cell supplies its own value unless one is typed.
    rawValue: input.rawValue != null ? input.rawValue : (input.sourceUnitId !== undefined && input.sourceUnitId !== old.sourceUnitId ? '' : old.rawValue),
    unit: input.unit || (money.UNITS.includes(old.originalUnit) ? old.originalUnit : 'INR'),
    periodStart: input.periodStart !== undefined ? input.periodStart : old.periodStart,
    periodEnd: input.periodEnd !== undefined ? input.periodEnd : old.periodEnd,
    basis: input.basis || old.basis,
    sourceVersionId: input.sourceVersionId !== undefined ? input.sourceVersionId : old.sourceVersionId,
    sourceUnitId: input.sourceUnitId !== undefined ? input.sourceUnitId : old.sourceUnitId,
    sourcePage: input.sourcePage !== undefined ? input.sourcePage : (old.sourceUnitId ? null : old.sourcePage),
    sourceCell: input.sourceCell !== undefined ? input.sourceCell : (old.sourceUnitId ? null : old.sourceCell),
    sourceTxnId: input.sourceTxnId !== undefined ? input.sourceTxnId : old.sourceTxnId,
    sourceNote: input.sourceNote != null ? input.sourceNote : old.sourceNote,
    confidence: input.confidence !== undefined ? input.confidence : old.confidence
  };
  const { cols } = await build(caseId, merged);
  const status = input.reviewStatus === 'provisional' ? 'provisional' : 'approved';
  const newId = await tx(async (cx) => {
    const locked = await cx.q('SELECT is_current FROM uw_facts WHERE id = ? FOR UPDATE', [factId]);
    if (!locked.length || !locked[0].is_current) throw bad('This fact was changed by someone else — reload.');
    const id = await insert(cx, caseId, cols, {
      origin: 'analyst', review_status: status, supersedes_id: factId, correction_reason: reason.slice(0, 500),
      created_by_id: user.id, created_by: user.name, reviewed_by_id: user.id, reviewed_by: user.name, reviewed_at: NOW
    });
    await cx.q('UPDATE uw_facts SET is_current = 0, superseded_by_id = ? WHERE id = ?', [id, factId]);
    return id;
  });
  return { before: old, after: await get(newId) };
}

/* Review status changes. Values never change here. */
const TRANSITIONS = {
  proposed: ['approved', 'provisional', 'rejected'],
  provisional: ['approved', 'rejected'],
  approved: ['rejected'],
  rejected: []
};
async function review(caseId, factId, { status, note }, user) {
  const f = await get(factId);
  if (!f || f.caseId !== caseId) throw Object.assign(new Error('Fact not found.'), { status: 404 });
  if (!f.isCurrent) throw bad('Superseded facts cannot be reviewed.');
  if (!(TRANSITIONS[f.reviewStatus] || []).includes(status)) throw bad('A ' + f.reviewStatus + ' fact cannot become ' + status + '.');
  if (status === 'rejected' && !String(note || '').trim()) throw bad('Say why the fact is rejected.');
  await q('UPDATE uw_facts SET review_status = ?, reviewed_by_id = ?, reviewed_by = ?, reviewed_at = NOW(3), review_note = ? WHERE id = ?',
    [status, user.id, user.name, String(note || '').slice(0, 500), factId]);
  return { before: f, after: await get(factId) };
}

async function history(caseId, factId) {
  const chain = [];
  let cur = await get(factId);
  if (!cur || cur.caseId !== caseId) return [];
  while (cur && cur.supersededById) cur = await get(cur.supersededById);
  while (cur) { chain.push(cur); cur = cur.supersedesId ? await get(cur.supersedesId) : null; }
  return chain;
}

module.exports = { list, get, create, correct, review, history, FACT_SELECT, mapRow };
