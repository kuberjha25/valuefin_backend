'use strict';
/* ============================================================================
   Configurable document checklist (spec §4).

   Items are configured per product (or for every product), may apply only
   above a borrower vintage, and may require periods: N annual periods (capped
   at the borrower's vintage when known) or N months of continuous coverage.

   Each item resolves to exactly one state:
     not_applicable      analyst marked it, with a reason
     missing             nothing classified as this type
     received_unreadable classified files exist but none could be read
     period_incomplete   readable files exist but do not cover the periods
     received            satisfied
   Only analyst-confirmed classifications count.
   ========================================================================== */
const { q } = require('../db/pool');

const ymd = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z');

/* Whole calendar months spanned by [start, end] if it starts on a 1st and
   ends on a month end; otherwise null. */
function monthSpan(start, end) {
  if (!start || !end) return null;
  const s = parse(start), e = parse(end);
  const next = new Date(e); next.setUTCDate(next.getUTCDate() + 1);
  if (s.getUTCDate() !== 1 || next.getUTCDate() !== 1) return null;
  return (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1;
}

function addMonths(isoDate, n) {
  const d = parse(isoDate);
  const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return ymd(d);
}

function covers(ranges, from, to) {
  const sorted = ranges.filter((r) => r.from && r.to).sort((a, b) => (a.from < b.from ? -1 : 1));
  let cursor = from;
  for (const r of sorted) {
    if (r.to < cursor) continue;
    if (r.from > cursor) return false;
    const after = new Date(parse(r.to)); after.setUTCDate(after.getUTCDate() + 1);
    cursor = ymd(after);
    if (cursor > to) return true;
  }
  return cursor > to;
}

async function itemsFor(product) {
  return q('SELECT * FROM uw_checklist_items WHERE active = 1 AND (product IS NULL OR product = ?) ORDER BY sort_order, id', [product]);
}

async function compute(c) {
  const items = await itemsFor(c.product);
  const marks = await q('SELECT * FROM uw_checklist_marks WHERE case_id = ?', [c.id]);
  const versions = await q(
    `SELECT v.id, v.document_id, v.original_name, v.doc_type, v.audit_status, v.period_start, v.period_end,
            v.intake_status, v.extraction_status, v.classification_confirmed
       FROM uw_document_versions v
      WHERE v.case_id = ? AND v.intake_status <> 'duplicate' AND v.classification_confirmed = 1`, [c.id]);
  const vintage = c.vintageYears == null ? null : Number(c.vintageYears);

  return items.map((it) => {
    const base = {
      itemId: it.id, key: it.item_key, label: it.label, docType: it.doc_type, mandatory: !!it.mandatory,
      periodRule: it.period_rule, periodsRequired: it.periods_required, auditedOnly: !!it.audited_only
    };
    if (it.min_vintage_years != null && vintage != null && vintage < Number(it.min_vintage_years)) {
      return Object.assign(base, { state: 'not_applicable', detail: 'Applies from ' + Number(it.min_vintage_years) + ' years of vintage.', automatic: true, versions: [] });
    }
    const mark = marks.find((m) => m.item_id === it.id);
    if (mark) return Object.assign(base, { state: 'not_applicable', detail: mark.reason, markedBy: mark.set_by, versions: [] });

    const typed = versions.filter((v) => v.doc_type === it.doc_type && (!it.audited_only || v.audit_status === 'audited'));
    const readable = typed.filter((v) => v.intake_status === 'accepted' && !['unreadable', 'failed'].includes(v.extraction_status));
    const vs = typed.map((v) => ({ id: v.id, name: v.original_name, periodStart: v.period_start, periodEnd: v.period_end, readable: readable.includes(v) }));

    if (!typed.length) {
      const wrongAudit = it.audited_only && versions.some((v) => v.doc_type === it.doc_type);
      return Object.assign(base, { state: 'missing', detail: wrongAudit ? 'Files of this type exist but none is marked audited.' : '', versions: vs });
    }
    if (!readable.length) return Object.assign(base, { state: 'received_unreadable', detail: 'Received, but no copy could be read — see the quarantine reason.', versions: vs });

    if (it.period_rule === 'annual' && it.periods_required) {
      let need = Number(it.periods_required);
      if (vintage != null) need = Math.max(1, Math.min(need, Math.floor(vintage)));
      const years = new Set(readable.filter((v) => monthSpan(v.period_start, v.period_end) === 12).map((v) => v.period_end));
      const unset = readable.filter((v) => !v.period_end).length;
      if (years.size < need) {
        return Object.assign(base, {
          state: 'period_incomplete', versions: vs,
          detail: years.size + ' of ' + need + ' annual period(s) on file' + (unset ? '; set the period on ' + unset + ' file(s)' : '') + '.'
        });
      }
      return Object.assign(base, { state: 'received', detail: years.size + ' annual period(s) on file.', versions: vs });
    }

    if (it.period_rule === 'monthly' && it.periods_required) {
      const need = Number(it.periods_required);
      const ranges = readable.map((v) => ({ from: v.period_start, to: v.period_end }));
      const latest = ranges.map((r) => r.to).filter(Boolean).sort().pop();
      if (!latest) return Object.assign(base, { state: 'period_incomplete', detail: 'Set the period on the file(s) to check coverage.', versions: vs });
      const from = ymd(new Date(parse(addMonths(latest, -need)).getTime() + 86400000));
      if (!covers(ranges, from, latest)) {
        return Object.assign(base, { state: 'period_incomplete', detail: 'Needs continuous coverage ' + from + ' to ' + latest + ' (' + need + ' months).', versions: vs });
      }
      return Object.assign(base, { state: 'received', detail: need + ' months covered to ' + latest + '.', versions: vs });
    }
    return Object.assign(base, { state: 'received', detail: '', versions: vs });
  });
}

const OUTSTANDING = ['missing', 'received_unreadable', 'period_incomplete'];
const missingMandatory = (list) => list.filter((i) => i.mandatory && OUTSTANDING.includes(i.state)).length;

module.exports = { compute, missingMandatory, monthSpan, addMonths, covers, OUTSTANDING };
