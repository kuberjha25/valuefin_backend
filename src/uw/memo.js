'use strict';
/* ============================================================================
   Memo citations and validation (spec §8.5, §10 "editable narrative with
   citation validation").

   Citation tokens an analyst (or, later, a model) writes into the memo:
     [[fact:123]]                       a fact
     [[calc:CODE:2025-03-31:audited]]   a calculation result in the latest run
     [[recon:CODE:2025-03-31]]          a reconciliation result in the latest run
     [[recon:CODE:2025-03-31:audited]]  … when that period was compared on several bases
     [[doc:45]]  [[doc:45:p3]]          a document version (optionally a page)
     [[txn:678]]                        a bank transaction
     [[check:9]]                        a public check

   The rule enforced here is the specification's: a financial amount that is
   not in the fact or calculation store is rejected. Every ₹ amount, % and
   multiple ("1.8x") in the text must be followed by a citation, and the stated
   figure must match the cited value within the precision it is written to.
   ========================================================================== */
const { q } = require('../db/pool');
const money = require('./money');
const uwrepo = require('./repo');
const { MEMO_SECTIONS } = require('./vocab');

const TOKEN = /\[\[([^\[\]]{1,120})\]\]/g;
const UNIT_RUPEES = { crore: 10000000n, crores: 10000000n, cr: 10000000n, lakh: 100000n, lakhs: 100000n, lac: 100000n, lacs: 100000n, l: 100000n, mn: 1000000n, million: 1000000n, k: 1000n, thousand: 1000n };

/* Find stated figures in the text: { kind, raw, digits, unit, start, end }. */
function findAmounts(text) {
  const found = [];
  const take = (re, kind) => {
    let m;
    while ((m = re.exec(text))) {
      const start = m.index, end = m.index + m[0].length;
      if (found.some((f) => start < f.end && end > f.start)) continue;     // overlapping, already taken
      if (/\[\[[^\]]*$/.test(text.slice(0, start))) continue;              // inside a citation token
      found.push({ kind, raw: m[0].trim().replace(/\.$/, ''), digits: m[1], unit: (m[2] || '').toLowerCase().replace(/\.$/, ''), start, end });
    }
  };
  take(/(?:₹|\bRs\.?|\bINR)\s*(-?\d[\d,]*(?:\.\d+)?)(?:\s*(crores?|cr|lakhs?|lacs?|mn|million|thousand|k|l)\b\.?)?/gi, 'money');
  take(/(-?\d[\d,]*(?:\.\d+)?)\s*(crores?|lakhs?|lacs?)\b/gi, 'money');
  take(/(-?\d[\d,]*(?:\.\d+)?)\s*(%)/g, 'percent');
  take(/(-?\d+(?:\.\d+)?)\s*(x|×)(?![A-Za-z0-9])/g, 'multiple');
  take(/(-?\d[\d,]*(?:\.\d+)?)\s*(days?)\b/gi, 'days');
  return found.sort((a, b) => a.start - b.start);
}

/* Value of a citation target: { kind: money|percent|ratio|days|number|text, micro?, label, problem?, warn? } */
async function resolve(token, caseId, ctx) {
  const parts = token.split(':');
  const type = parts[0];
  const id = Number(parts[1]);
  switch (type) {
    case 'fact': {
      const f = ctx.facts.get(id);
      if (!f) return { problem: 'cites fact #' + parts[1] + ', which is not on this case.' };
      if (!f.isCurrent) return { problem: 'cites fact #' + id + ', which was superseded by #' + f.supersededById + ' — update the citation.' };
      if (f.reviewStatus === 'rejected') return { problem: 'cites fact #' + id + ', which was rejected.' };
      if (f.reviewStatus === 'proposed') return { problem: 'cites fact #' + id + ', which has not been reviewed.' };
      const warn = f.reviewStatus === 'provisional' ? 'cites provisional fact #' + id + '.' : null;
      const label = (f.fieldLabel || f.fieldCode) + (f.periodEnd ? ' (' + (f.periodStart ? f.periodStart + ' to ' : 'as at ') + f.periodEnd + ', ' + f.basis + ')' : '');
      if (f.valueType === 'money') return { kind: 'money', micro: money.paiseToMicro(f.amountPaise), label, warn, fact: f };
      if (f.valueType === 'percent') return { kind: 'percent', micro: money.toMicro(f.valueNum), label, warn, fact: f };
      if (f.valueType === 'number') return { kind: 'number', micro: money.toMicro(f.valueNum), label, warn, fact: f };
      return { kind: 'text', label, warn, fact: f };
    }
    case 'calc': {
      if (parts.length !== 4) return { problem: 'calc citations look like [[calc:CODE:YYYY-MM-DD:basis]].' };
      const r = ctx.calcs.find((c) => c.formulaCode === parts[1] && c.periodEnd === parts[2] && c.basis === parts[3]);
      if (!r) return { problem: 'no result for ' + token + ' in the latest analysis run.' };
      if (r.status !== 'computed') return { problem: token + ' is not computable: ' + r.rationale };
      const fo = ctx.formulaFormat.get(r.formulaCode + ':' + r.formulaVersion) || 'number';
      const kind = { percent: 'percent', ratio: 'ratio', days: 'days', amount: 'money', number: 'number' }[fo];
      return { kind, micro: money.toMicro(r.value), label: r.formulaCode + ' v' + r.formulaVersion + ' ' + r.basis + ' ' + (r.periodStart ? r.periodStart + ' to ' : 'as at ') + r.periodEnd, warn: r.provisional ? token + ' uses provisional facts.' : null, calc: r };
    }
    case 'recon': {
      if (parts.length !== 3 && parts.length !== 4) return { problem: 'recon citations look like [[recon:CODE:YYYY-MM-DD]] or [[recon:CODE:YYYY-MM-DD:basis]].' };
      const hits = ctx.recons.filter((c) => c.defCode === parts[1] && c.periodEnd === parts[2]
        && (parts.length === 3 || String(c.comparableBasis).startsWith(parts[3] + ' vs ')));
      if (!hits.length) return { problem: 'no reconciliation ' + token + ' in the latest analysis run.' };
      if (hits.length > 1) return { problem: token + ' matches ' + hits.length + ' results on different bases — cite as [[recon:' + parts[1] + ':' + parts[2] + ':basis]].' };
      const r = hits[0];
      return { kind: 'recon', label: r.defCode + ' ' + r.periodEnd + ' (' + r.comparableBasis + ') — ' + r.outcome.replace(/_/g, ' '), recon: r };
    }
    case 'doc': {
      const v = ctx.versions.get(id);
      if (!v) return { problem: 'cites document version #' + parts[1] + ', which is not on this case.' };
      if (parts[2]) {
        const m = /^p(\d+)$/.exec(parts[2]);
        if (!m) return { problem: 'page references look like [[doc:ID:p3]].' };
        if (v.page_count && +m[1] > v.page_count) return { problem: 'page ' + m[1] + ' does not exist in ' + v.original_name + '.' };
      }
      return { kind: 'text', label: v.original_name + (parts[2] ? ' ' + parts[2] : '') };
    }
    case 'txn': {
      const t = ctx.txns.get(id);
      if (!t) return { problem: 'cites transaction #' + parts[1] + ', which is not on this case.' };
      return { kind: 'money', micro: money.paiseToMicro(t.amount_paise), label: t.value_date + ' ' + t.direction + ' ' + String(t.raw_narration).slice(0, 60) };
    }
    case 'check': {
      const c = ctx.checks.get(id);
      if (!c) return { problem: 'cites public check #' + parts[1] + ', which is not on this case.' };
      return { kind: 'text', label: c.source_name + ' — ' + c.status.replace(/_/g, ' ') };
    }
    default: return { problem: 'unknown citation type "' + type + '".' };
  }
}

/* Does the stated figure match the cited value at the precision written? */
function matches(stated, target) {
  const p = money.parseDecimal(stated.digits.replace(/^-/, ''));
  if (!p) return { ok: false, why: 'unreadable number' };
  const neg = stated.digits.startsWith('-');
  let scale = 1n;
  if (stated.kind === 'money' && stated.unit) scale = UNIT_RUPEES[stated.unit] || 1n;
  // Stated value and half of its last written digit, both in micro-units.
  const statedMicro = money.divRound(p.digits * scale * 1000000n, 10n ** BigInt(p.scale)) * (neg ? -1n : 1n);
  const halfStep = money.divRound(scale * 1000000n, 2n * 10n ** BigInt(p.scale));
  const diff = statedMicro - target.micro;
  return { ok: (diff < 0n ? -diff : diff) <= halfStep };
}

const KIND_OK = { money: ['money'], percent: ['percent'], multiple: ['ratio'], days: ['days'] };

async function context(caseId) {
  const { results } = require('./engine');
  const res = await results(caseId);
  const facts = await require('./facts').list(caseId, { all: true });
  const formulaIds = Array.from(new Set(res.calcs.map((c) => c.formulaId)));
  const formulas = formulaIds.length ? await q('SELECT code, version, definition FROM uw_formulas WHERE id IN (?)', [formulaIds]) : [];
  return {
    facts: new Map(facts.map((f) => [f.id, f])),
    calcs: res.calcs, recons: res.recons,
    formulaFormat: new Map(formulas.map((f) => [f.code + ':' + f.version, (uwrepo.j(f.definition) || {}).format])),
    versions: new Map((await q('SELECT id, original_name, page_count FROM uw_document_versions WHERE case_id = ?', [caseId])).map((v) => [v.id, v])),
    txns: new Map((await q('SELECT id, value_date, direction, amount_paise, raw_narration FROM uw_transactions WHERE case_id = ?', [caseId])).map((t) => [t.id, t])),
    checks: new Map((await q('SELECT c.id, c.status, s.name AS source_name FROM uw_public_checks c JOIN uw_sources s ON s.id = c.source_id WHERE c.case_id = ?', [caseId])).map((c) => [c.id, c]))
  };
}

/* Validate every section. Returns { errors, warnings, citations }. */
async function validate(caseId, sections, ctx) {
  ctx = ctx || await context(caseId);
  const errors = [], warnings = [], citations = [];
  for (const [key, label] of MEMO_SECTIONS) {
    const text = sections[key] || '';
    if (!text.trim()) continue;
    const say = (list, msg) => list.push({ section: key, sectionLabel: label, message: msg });

    const tokens = [];
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(text))) tokens.push({ token: m[1].trim(), start: m.index, end: m.index + m[0].length });
    const resolved = new Map();
    for (const t of tokens) {
      if (!resolved.has(t.token)) resolved.set(t.token, await resolve(t.token, caseId, ctx));
      const r = resolved.get(t.token);
      if (r.problem) say(errors, r.problem);
      else { if (r.warn) say(warnings, r.warn); citations.push({ section: key, token: t.token, label: r.label }); }
    }

    for (const a of findAmounts(text)) {
      const next = /^[\s)\]]*\[\[([^\[\]]{1,120})\]\]/.exec(text.slice(a.end));
      if (!next) {
        if (a.kind === 'days') continue;              // day counts are only checked when cited
        say(errors, '"' + a.raw + '" has no citation. Cite the fact or calculation it comes from, e.g. ' + a.raw + ' [[fact:ID]].');
        continue;
      }
      const r = resolved.get(next[1].trim()) || await resolve(next[1].trim(), caseId, ctx);
      if (r.problem) continue;                         // already reported above
      if (!(KIND_OK[a.kind] || []).includes(r.kind) && !(a.kind === 'money' && r.kind === 'number')) {
        say(errors, '"' + a.raw + '" cites ' + next[1] + ' (' + (r.label || r.kind) + '), which is not a ' + (a.kind === 'multiple' ? 'ratio' : a.kind) + ' value.');
        continue;
      }
      if (r.micro == null) continue;
      const res = matches(a, r);
      if (!res.ok) {
        say(errors, '"' + a.raw + '" does not match ' + next[1] + ' (' + r.label + ' = ' + money.fixedToString(r.micro, 6).replace(/\.?0+$/, '') + (r.kind === 'money' ? ' rupees' : '') + ').');
      }
    }
  }
  return { errors, warnings, citations };
}

async function getSections(caseId) {
  const rows = await q('SELECT section_key, body, updated_by, updated_at FROM uw_memo_sections WHERE case_id = ?', [caseId]);
  const out = {};
  const meta = {};
  rows.forEach((r) => { out[r.section_key] = r.body; meta[r.section_key] = { updatedBy: r.updated_by, updatedAt: uwrepo.iso(r.updated_at) }; });
  return { sections: out, meta };
}

module.exports = { validate, context, getSections, findAmounts, matches, resolve };
