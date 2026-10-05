'use strict';
/* ============================================================================
   Deterministic engine (spec §2.5, §5, §8.2, §8.6, §9).

   One run = every approved, effective formula, reconciliation and policy rule
   evaluated against the case's current facts. Each run is stored with the
   exact versions it used, so any output can be traced to its inputs.

   Principles carried straight from the specification:
   * Only reviewed facts (approved) or explicitly provisional facts are used;
     outputs that rely on a provisional fact are flagged provisional.
   * "Not computable" beats a made-up zero or an invalid ratio: a missing
     input, two disagreeing facts, a zero or (where required) negative
     denominator all produce not_computable with the reason.
   * No threshold is ever assumed. A reconciliation without a configured
     tolerance reports its gap as "tolerance not configured"; a rule only runs
     once its credit-owner threshold exists and two people approved it.
   ========================================================================== */
const crypto = require('crypto');
const { q, tx } = require('../db/pool');
const money = require('./money');
const uwrepo = require('./repo');
const checklist = require('./checklist');
const bank = require('./bank');
const { BASES, CASE_METRICS, OPERATORS } = require('./vocab');

const prevDay = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
/* The business date comes from the database server — the same clock that
   stamps approvals — so "effective from today" means the same day everywhere. */
async function dbToday() {
  const [r] = await q("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS d");
  return r.d;
}
const effective = (o, day) => o.status === 'approved' && (!o.effectiveFrom || o.effectiveFrom <= day) && (!o.effectiveTo || o.effectiveTo >= day);

/* Latest approved version of each code that is in effect on the given day. */
function latestEffective(list, day) {
  const by = new Map();
  list.filter((o) => effective(o, day)).forEach((o) => { const cur = by.get(o.code); if (!cur || o.version > cur.version) by.set(o.code, o); });
  return Array.from(by.values()).sort((a, b) => a.code.localeCompare(b.code));
}

/* ---------------- definition validation (used by the config routes) ---------------- */
const FORMATS = ['ratio', 'percent', 'days', 'amount', 'number'];

function validateTerms(terms, fields, label, { allowOffset }) {
  if (!Array.isArray(terms)) throw new Error(label + ' must be a list of terms.');
  return terms.map((t, i) => {
    const f = fields.get(t.field);
    if (!f) throw new Error(label + ' term ' + (i + 1) + ': unknown field code "' + t.field + '".');
    if (!['money', 'number', 'percent'].includes(f.valueType)) throw new Error(label + ' term ' + (i + 1) + ': "' + t.field + '" is not numeric.');
    const sign = Number(t.sign == null ? 1 : t.sign);
    if (sign !== 1 && sign !== -1) throw new Error(label + ' term ' + (i + 1) + ': sign must be 1 or -1.');
    const offset = Number(t.offset || 0);
    if (offset !== 0 && !(allowOffset && offset === -1)) throw new Error(label + ' term ' + (i + 1) + ': period offset must be 0' + (allowOffset ? ' or -1' : '') + '.');
    return { field: f.code, sign, offset };
  });
}

function sameKind(terms, fields, label) {
  const kinds = new Set(terms.map((t) => (fields.get(t.field).valueType === 'money' ? 'money' : 'number')));
  if (kinds.size > 1) throw new Error(label + ' mixes money and non-money fields.');
  return kinds.values().next().value || null;
}

function validateFormulaDef(def, fields) {
  if (!def || typeof def !== 'object') throw new Error('Definition is required.');
  const numerator = validateTerms(def.numerator, fields, 'Numerator', { allowOffset: true });
  const denominator = validateTerms(def.denominator || [], fields, 'Denominator', { allowOffset: true });
  if (!numerator.length) throw new Error('The numerator needs at least one term.');
  sameKind(numerator, fields, 'Numerator'); sameKind(denominator, fields, 'Denominator');
  const multiplier = String(def.multiplier == null ? '1' : def.multiplier).trim();
  if (!/^[1-9]\d{0,5}$/.test(multiplier)) throw new Error('Multiplier must be a whole number between 1 and 999999 (e.g. 1, 100, 365).');
  const format = FORMATS.includes(def.format) ? def.format : null;
  if (!format) throw new Error('Format must be one of: ' + FORMATS.join(', ') + '.');
  const basis = def.basis == null || def.basis === 'same' ? 'same' : def.basis;
  if (basis !== 'same' && !BASES.includes(basis)) throw new Error('Basis must be "same" or one of: ' + BASES.join(', ') + '.');
  const all = numerator.concat(denominator);
  const flows = all.filter((t) => fields.get(t.field).periodKind === 'flow');
  if (!flows.length && all.some((t) => t.offset === -1)) throw new Error('A prior-period term needs at least one flow (period) field to anchor the period.');
  if (all.some((t) => fields.get(t.field).periodKind === 'none')) throw new Error('Formula fields must be flow or stock fields.');
  let periodMonths = null;
  if (def.periodMonths != null && def.periodMonths !== '') {
    periodMonths = Number(def.periodMonths);
    if (!Number.isInteger(periodMonths) || periodMonths < 1 || periodMonths > 12) throw new Error('Period length must be a whole number of months from 1 to 12.');
    if (!flows.length) throw new Error('A period-length restriction needs at least one flow (period) field.');
  }
  return {
    numerator, denominator, multiplier, format, basis, periodMonths,
    denominatorMustBePositive: !!def.denominatorMustBePositive,
    missingTreatment: 'not_computable'
  };
}

function validateReconDef(def, fields) {
  if (!def || typeof def !== 'object') throw new Error('Definition is required.');
  const side = (s, label) => {
    if (!s || typeof s !== 'object') throw new Error(label + ' side is required.');
    const terms = validateTerms(s.terms, fields, label, { allowOffset: false });
    if (!terms.length) throw new Error(label + ' side needs at least one term.');
    if (terms.some((t) => fields.get(t.field).valueType !== 'money')) throw new Error(label + ' side must use money fields.');
    const basis = s.basis == null || s.basis === '' ? null : s.basis;
    if (basis && !BASES.includes(basis)) throw new Error(label + ' basis must be one of: ' + BASES.join(', ') + '.');
    return { terms, basis };
  };
  const left = side(def.left, 'Left'), right = side(def.right, 'Right');
  const kinds = new Set(left.terms.concat(right.terms).map((t) => fields.get(t.field).periodKind));
  if (kinds.size > 1) throw new Error('Both sides must compare like with like: all flow (same period) or all stock (same date).');
  const toleranceMode = def.toleranceMode === 'either' ? 'either' : 'both';
  return { left, right, toleranceMode };
}

/* Parse "formula:CODE@basis", "fact:CODE@basis" or a fixed case metric. */
function parseMetric(metric) {
  const s = String(metric || '').trim();
  let m = /^(formula|fact):([a-z0-9_]+)@([a-z_]+)$/.exec(s);
  if (m) {
    if (m[3] !== 'latest' && !BASES.includes(m[3])) throw new Error('Basis after @ must be "latest" or one of: ' + BASES.join(', ') + '.');
    return { kind: m[1], code: m[2], basis: m[3] };
  }
  const fixed = CASE_METRICS.find(([k]) => k === s);
  if (fixed) return { kind: 'fixed', code: s, valueType: fixed[1] };
  throw new Error('Unknown metric "' + s + '". Use formula:CODE@basis, fact:CODE@basis, or one of the listed case metrics.');
}

/* Compare a metric value with a threshold. Numbers compare exactly as decimals. */
function compare(op, value, threshold) {
  if (!OPERATORS.includes(op)) throw new Error('Unknown operator');
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(threshold)) throw new Error('Threshold for in/not_in must be a list.');
    const v = String(value).trim().toLowerCase();
    const hit = threshold.some((t) => String(t).trim().toLowerCase() === v);
    return op === 'in' ? hit : !hit;
  }
  const a = money.toMicro(String(value));
  const b = money.toMicro(String(threshold));
  if (a == null || b == null) {
    if (op === 'eq' || op === 'neq') {
      const eq = String(value).trim().toLowerCase() === String(threshold).trim().toLowerCase();
      return op === 'eq' ? eq : !eq;
    }
    throw new Error('Non-numeric comparison');
  }
  switch (op) {
    case 'gt': return a > b; case 'gte': return a >= b;
    case 'lt': return a < b; case 'lte': return a <= b;
    case 'eq': return a === b; case 'neq': return a !== b;
    default: return false;
  }
}

function validateRule(r) {
  const metric = parseMetric(r.metric);
  if (!OPERATORS.includes(r.operator)) throw new Error('Operator must be one of: ' + OPERATORS.join(', ') + '.');
  if (r.threshold != null) {
    if (['in', 'not_in'].includes(r.operator)) {
      if (!Array.isArray(r.threshold) || !r.threshold.length || r.threshold.some((x) => !String(x).trim())) throw new Error('For in / not in, the threshold is a non-empty list of values.');
    } else if (metric.valueType !== 'text' && money.toMicro(String(r.threshold)) == null) {
      throw new Error('Threshold must be a number for this metric.');
    }
  }
  const tests = Array.isArray(r.testCases) ? r.testCases : [];
  tests.forEach((t, i) => {
    if (t.value == null || String(t.value).trim() === '') throw new Error('Test case ' + (i + 1) + ' needs a metric value.');
    if (!['triggered', 'not_triggered'].includes(t.expected)) throw new Error('Test case ' + (i + 1) + ' must expect triggered or not_triggered.');
  });
  return metric;
}

/* Run a rule's own test cases. Returns [{ ..., actual, pass }]. */
function runRuleTests(r) {
  return (r.testCases || []).map((t) => {
    let actual;
    try { actual = compare(r.operator, t.value, r.threshold) ? 'triggered' : 'not_triggered'; }
    catch (e) { actual = 'error: ' + e.message; }
    return Object.assign({}, t, { actual, pass: actual === t.expected });
  });
}

/* ---------------- fact access ---------------- */
async function usableFacts(caseId) {
  const rows = await q(
    `SELECT f.*, CAST(f.value_num AS CHAR) AS value_num_str FROM uw_facts f
      WHERE f.case_id = ? AND f.is_current = 1 AND f.review_status IN ('approved','provisional')`, [caseId]);
  return rows.map((r) => Object.assign(uwrepo.mapFact(r), { valueNum: r.value_num_str }));
}

/* Value of a numeric fact as micro-units (BigInt). Money: rupees × 10^6. */
const factMicro = (f) => (f.valueType === 'money' ? money.paiseToMicro(f.amountPaise) : money.toMicro(f.valueNum));

/* Pick the single fact for (field, period, basis). Several current facts with
   the same value are fine; differing values are a conflict to resolve. */
function pick(facts, field, match, basis) {
  const hits = facts.filter((f) => f.fieldCode === field && f.basis === basis && match(f));
  if (!hits.length) return { missing: true };
  const vals = new Set(hits.map((f) => String(factMicro(f))));
  if (vals.size > 1) return { conflict: hits.map((f) => '#' + f.id).join(', ') };
  return { fact: hits.sort((a, b) => a.id - b.id)[0] };
}

/* ---------------- formulas ---------------- */
function computeFormulas(formulas, facts, fields) {
  const out = [];
  for (const fo of formulas) {
    const d = fo.definition;
    const terms = d.numerator.map((t) => Object.assign({ part: 'n' }, t)).concat(d.denominator.map((t) => Object.assign({ part: 'd' }, t)));
    const kind = (t) => fields.get(t.field).periodKind;
    const anchors = terms.filter((t) => t.offset === 0 && kind(t) === 'flow');
    const anchorFields = new Set((anchors.length ? anchors : terms.filter((t) => t.offset === 0)).map((t) => t.field));

    // Candidate (period, basis) pairs: wherever at least one anchor input exists.
    const cands = new Map();
    facts.filter((f) => anchorFields.has(f.fieldCode)).forEach((f) => {
      if (d.basis !== 'same' && f.basis !== d.basis) return;
      const start = anchors.length ? f.periodStart : null;
      if (anchors.length && !f.periodStart) return;
      if (!f.periodEnd) return;
      // e.g. day-count measures built on 365 days only make sense for a year.
      if (d.periodMonths && anchors.length && checklist.monthSpan(f.periodStart, f.periodEnd) !== d.periodMonths) return;
      const key = (start || '') + '|' + f.periodEnd + '|' + f.basis;
      cands.set(key, { start, end: f.periodEnd, basis: f.basis });
    });

    for (const c of Array.from(cands.values()).sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : a.basis.localeCompare(b.basis)))) {
      const used = [];
      let problem = null;
      let provisional = false;
      const sums = { n: 0n, d: 0n };
      const prevEnd = c.start ? prevDay(c.start) : null;
      const span = checklist.monthSpan(c.start, c.end);
      const lengthDays = c.start ? Math.round((new Date(c.end) - new Date(c.start)) / 86400000) : null;

      for (const t of terms) {
        const pk = kind(t);
        let match;
        if (t.offset === 0) {
          match = pk === 'flow' ? (f) => f.periodStart === c.start && f.periodEnd === c.end : (f) => f.periodEnd === c.end;
        } else {
          match = pk === 'flow'
            ? (f) => f.periodEnd === prevEnd && !!f.periodStart && (span != null
              ? checklist.monthSpan(f.periodStart, f.periodEnd) === span
              : Math.round((new Date(f.periodEnd) - new Date(f.periodStart)) / 86400000) === lengthDays)
            : (f) => f.periodEnd === prevEnd;
        }
        const r = pick(facts, t.field, match, c.basis);
        const where = t.offset === -1 ? ' (prior period)' : '';
        if (r.missing) { problem = 'Missing ' + t.field + where + ' on ' + c.basis + ' basis.'; break; }
        if (r.conflict) { problem = 'Conflicting ' + t.field + where + ' facts ' + r.conflict + ' — correct or reject one.'; break; }
        used.push(r.fact.id);
        if (r.fact.reviewStatus === 'provisional') provisional = true;
        const v = factMicro(r.fact);
        sums[t.part] += t.sign === -1 ? -v : v;
      }

      const row = {
        formulaId: fo.id, formulaCode: fo.code, formulaVersion: fo.version,
        periodStart: c.start, periodEnd: c.end, basis: c.basis, inputFactIds: used, provisional
      };
      if (problem) { out.push(Object.assign(row, { status: 'not_computable', rationale: problem })); continue; }

      const mult = BigInt(d.multiplier);
      row.numerator = money.fixedToString(sums.n, 6);
      if (d.denominator.length) {
        row.denominator = money.fixedToString(sums.d, 6);
        if (sums.d === 0n) { out.push(Object.assign(row, { status: 'not_computable', rationale: 'Denominator is zero.' })); continue; }
        if (d.denominatorMustBePositive && sums.d < 0n) { out.push(Object.assign(row, { status: 'not_computable', rationale: 'Denominator is negative, which this measure does not allow.' })); continue; }
        row.value = money.ratioString(sums.n, sums.d, mult, 10);
      } else {
        row.value = money.ratioString(sums.n * mult, 1000000n, 1n, 10);
      }
      out.push(Object.assign(row, { status: 'computed', rationale: '' }));
    }
  }
  return out;
}

/* ---------------- reconciliations ---------------- */
function computeRecons(defs, facts, fields, previous) {
  const out = [];
  for (const def of defs) {
    const d = def.definition;
    const flow = fields.get(d.left.terms[0].field).periodKind === 'flow';
    const sideFields = new Set(d.left.terms.concat(d.right.terms).map((t) => t.field));
    const periods = new Map();
    facts.filter((f) => sideFields.has(f.fieldCode) && f.periodEnd && (!flow || f.periodStart)).forEach((f) => {
      const key = (flow ? f.periodStart : '') + '|' + f.periodEnd;
      periods.set(key, { start: flow ? f.periodStart : null, end: f.periodEnd });
    });

    const onSide = (side, f) => side.terms.some((t) => t.field === f.fieldCode);
    for (const p of Array.from(periods.values()).sort((a, b) => (a.end < b.end ? -1 : 1))) {
      const match = flow ? (f) => f.periodStart === p.start && f.periodEnd === p.end : (f) => f.periodEnd === p.end;
      // A reconciliation only exists where both sides have something to compare.
      if (!facts.some((f) => onSide(d.left, f) && match(f)) || !facts.some((f) => onSide(d.right, f) && match(f))) continue;

      // Neither side names a basis: compare like with like, once for each
      // basis present on both sides (e.g. an audited balance sheet tie and an
      // unaudited one are two separate checks).
      let pairs;
      if (!d.left.basis && !d.right.basis) {
        const basesOf = (side) => new Set(facts.filter((f) => onSide(side, f) && match(f)).map((f) => f.basis));
        const lb = basesOf(d.left), rb = basesOf(d.right);
        const common = Array.from(lb).filter((b) => rb.has(b)).sort();
        pairs = common.length ? common.map((b) => [b, b])
          : [[null, null, 'no basis present on both sides (left: ' + Array.from(lb).join(', ') + '; right: ' + Array.from(rb).join(', ') + ').']];
      } else {
        pairs = [[d.left.basis, d.right.basis]];
      }

      for (const [forcedL, forcedR, pairProblem] of pairs) {
        const evalSide = (side, forced) => {
          if (pairProblem) return { problem: pairProblem };
          let basis = forced || side.basis;
          if (!basis) {
            const bases = new Set(facts.filter((f) => side.terms.some((t) => t.field === f.fieldCode) && match(f)).map((f) => f.basis));
            if (bases.size > 1) return { problem: 'facts on more than one basis (' + Array.from(bases).join(', ') + ') — the definition must name the basis.' };
            basis = bases.values().next().value;
            if (!basis) return { problem: 'no ' + side.terms.map((t) => t.field).join(' / ') + ' fact for this period.' };
          }
          let sum = 0n; const ids = []; let provisional = false;
          for (const t of side.terms) {
            const r = pick(facts, t.field, match, basis);
            if (r.missing) return { problem: 'no ' + t.field + ' fact on ' + basis + ' basis for this period.' };
            if (r.conflict) return { problem: 'conflicting ' + t.field + ' facts ' + r.conflict + '.' };
            ids.push(r.fact.id);
            if (r.fact.reviewStatus === 'provisional') provisional = true;
            sum += (t.sign === -1 ? -1n : 1n) * BigInt(r.fact.amountPaise);
          }
          return { sum, ids, basis, provisional, values: ids.map((id) => [id, String(facts.find((f) => f.id === id).amountPaise)]) };
        };
        const L = evalSide(d.left, forcedL), R = evalSide(d.right, forcedR);
        const row = {
          defId: def.id, defCode: def.code, defVersion: def.version, periodStart: p.start, periodEnd: p.end,
          leftFactIds: L.ids || [], rightFactIds: R.ids || [],
          tolerancePct: def.tolerancePct, toleranceAbsPaise: def.toleranceAbsPaise,
          comparableBasis: (L.basis || '?') + ' vs ' + (R.basis || '?') + (flow ? ', period ' + p.start + ' to ' + p.end : ', as at ' + p.end)
        };
        if (L.problem || R.problem) {
          Object.assign(row, { outcome: 'not_computable', rationale: [L.problem && 'Left: ' + L.problem, R.problem && 'Right: ' + R.problem].filter(Boolean).join(' ') });
        } else {
          const gap = L.sum - R.sum;
          const absGap = gap < 0n ? -gap : gap;
          const gapPct = R.sum !== 0n ? money.ratioString(gap, R.sum, 100n, 6) : null;
          Object.assign(row, { leftPaise: L.sum.toString(), rightPaise: R.sum.toString(), gapPaise: gap.toString(), gapPct });
          const hasPct = def.tolerancePct != null, hasAbs = def.toleranceAbsPaise != null;
          if (!hasPct && !hasAbs) {
            Object.assign(row, { outcome: 'tolerance_not_configured', rationale: 'Gap shown; the credit owner has not set a tolerance for this check.' });
          } else {
            const okAbs = hasAbs ? absGap <= BigInt(def.toleranceAbsPaise) : null;
            let okPct = null;
            if (hasPct) {
              if (R.sum === 0n) okPct = gap === 0n;
              else {
                const pctMicro = money.toMicro(gapPct.replace('-', ''));
                okPct = pctMicro <= money.toMicro(String(def.tolerancePct));
              }
            }
            const checks = [okAbs, okPct].filter((x) => x !== null);
            const ok = d.toleranceMode === 'either' ? checks.some(Boolean) : checks.every(Boolean);
            Object.assign(row, { outcome: ok ? 'within_tolerance' : 'outside_tolerance', rationale: '' });
          }
          if (L.provisional || R.provisional) row.rationale = (row.rationale + ' Uses provisional facts.').trim();
        }
        row.inputSignature = crypto.createHash('sha256').update(JSON.stringify([def.id, p, forcedL, forcedR, L.values || L.problem, R.values || R.problem])).digest('hex');
        // An explanation survives a re-run only while the inputs are identical.
        const prev = previous.find((x) => x.inputSignature === row.inputSignature && x.resolution !== 'none');
        if (prev) Object.assign(row, { resolution: prev.resolution, explanation: prev.explanation, evidenceRefs: prev.evidenceRefs, resolvedBy: prev.resolvedBy, resolvedAt: prev.resolvedAt });
        out.push(row);
      }
    }
  }
  return out;
}

/* ---------------- metrics + rules ---------------- */
function latestBy(rows, basis, valueOf) {
  const pool = basis === 'latest' ? rows : rows.filter((r) => r.basis === basis);
  if (!pool.length) return { problem: 'no value' + (basis === 'latest' ? '' : ' on ' + basis + ' basis') + '.' };
  const maxEnd = pool.reduce((m, r) => (r.periodEnd > m ? r.periodEnd : m), '');
  const atEnd = pool.filter((r) => r.periodEnd === maxEnd);
  const bases = new Set(atEnd.map((r) => r.basis));
  if (bases.size > 1) return { problem: 'more than one basis for period ending ' + maxEnd + ' (' + Array.from(bases).join(', ') + ') — name the basis in the rule.' };
  return valueOf(atEnd, maxEnd);
}

async function metricValue(metric, ctx) {
  const m = parseMetric(metric);
  if (m.kind === 'formula') {
    const rows = ctx.calcs.filter((r) => r.formulaCode === m.code);
    if (!rows.length) return { problem: 'formula ' + m.code + ' has no results (not approved, or no inputs).' };
    return latestBy(rows, m.basis, (atEnd, end) => {
      if (atEnd.length > 1) return { problem: 'several results for period ending ' + end + '.' };
      const r = atEnd[0];
      if (r.status !== 'computed') return { problem: m.code + ' not computable for period ending ' + end + ': ' + r.rationale };
      return { value: r.value, provisional: r.provisional, note: m.code + ' ' + r.basis + ' period ending ' + end };
    });
  }
  if (m.kind === 'fact') {
    const rows = ctx.facts.filter((f) => f.fieldCode === m.code && f.periodEnd);
    if (!rows.length) return { problem: 'no ' + m.code + ' fact.' };
    return latestBy(rows, m.basis, (atEnd, end) => {
      const vals = new Set(atEnd.map((f) => (f.valueType === 'money' ? String(f.amountPaise) : String(f.valueNum != null ? f.valueNum : f.valueText))));
      if (vals.size > 1) return { problem: 'conflicting ' + m.code + ' facts for ' + end + '.' };
      const f = atEnd[0];
      const value = f.valueType === 'money' ? money.paiseToRupeeString(f.amountPaise) : (f.valueNum != null ? f.valueNum : f.valueText);
      return { value, provisional: f.reviewStatus === 'provisional', note: m.code + ' ' + f.basis + ' as at ' + end };
    });
  }
  const c = ctx.case;
  switch (m.code) {
    case 'case.sector': return c.sector ? { value: c.sector } : { problem: 'sector not recorded on the case.' };
    case 'case.product': return { value: c.product };
    case 'case.requested_amount': return { value: money.paiseToRupeeString(c.requestedPaise) };
    case 'case.tenor_days': return { value: String(c.tenorDays) };
    case 'case.vintage_years': return c.vintageYears == null ? { problem: 'vintage not recorded on the case.' } : { value: String(c.vintageYears) };
    case 'public.critical_count': return { value: String(ctx.checks.filter((x) => x.critical && x.status === 'match_found').length) };
    case 'public.unresolved_count': return { value: String(ctx.checks.filter((x) => ['pending', 'failed', 'manual_review_required'].includes(x.status)).length) };
    case 'recon.outside_tolerance_unexplained': return { value: String(ctx.recons.filter((r) => r.outcome === 'outside_tolerance' && r.resolution !== 'explained').length) };
    case 'docs.missing_mandatory_count': return { value: String(checklist.missingMandatory(ctx.checklist)) };
    case 'bank.unknown_credit_share_pct':
      return ctx.bank.metrics.unknownCreditSharePct == null ? { problem: 'no bank receipts imported.' } : { value: ctx.bank.metrics.unknownCreditSharePct };
    case 'bank.financing_credit_share_pct':
      return ctx.bank.metrics.financingCreditSharePct == null ? { problem: 'no bank receipts imported.' } : { value: ctx.bank.metrics.financingCreditSharePct };
    case 'bank.top_counterparty_share_pct':
      return ctx.bank.metrics.topCounterpartySharePct == null ? { problem: 'no tagged operating counterparties.' } : { value: ctx.bank.metrics.topCounterpartySharePct };
    case 'bank.return_count': return { value: String(ctx.bank.metrics.returnCount) };
    default: return { problem: 'metric not available.' };
  }
}

async function evaluateRules(rules, ctx) {
  const out = [];
  for (const r of rules) {
    if (Array.isArray(r.products) && r.products.length && !r.products.includes(ctx.case.product)) continue;
    const base = { ruleId: r.id, ruleCode: r.code, ruleVersion: r.version, ruleClass: r.ruleClass, metric: r.metric };
    let mv;
    try { mv = await metricValue(r.metric, ctx); } catch (e) { mv = { problem: e.message }; }
    if (mv.problem) { out.push(Object.assign(base, { outcome: 'not_evaluable', metricValue: null, detail: 'Cannot evaluate: ' + mv.problem })); continue; }
    let hit;
    try { hit = compare(r.operator, mv.value, r.threshold); }
    catch (e) { out.push(Object.assign(base, { outcome: 'not_evaluable', metricValue: mv.value, detail: 'Cannot compare: ' + e.message })); continue; }
    const thr = Array.isArray(r.threshold) ? '[' + r.threshold.join(', ') + ']' : String(r.threshold);
    out.push(Object.assign(base, {
      outcome: hit ? 'triggered' : 'not_triggered', metricValue: String(mv.value).slice(0, 255),
      detail: (mv.note ? mv.note + ': ' : '') + mv.value + ' ' + r.operator + ' ' + thr + (mv.provisional ? ' (provisional input)' : '')
    }));
  }
  return out;
}

/* ---------------- the run ---------------- */
async function loadFields() {
  const rows = (await q('SELECT * FROM uw_field_codes')).map(uwrepo.mapFieldCode);
  return new Map(rows.map((f) => [f.code, f]));
}

async function latestRunId(caseId) {
  const rows = await q('SELECT id FROM uw_runs WHERE case_id = ? ORDER BY id DESC LIMIT 1', [caseId]);
  return rows.length ? rows[0].id : null;
}

async function run(caseId, { reason = '', user = null } = {}) {
  const c = await uwrepo.getCase(caseId);
  if (!c) throw Object.assign(new Error('Case not found.'), { status: 404 });
  const day = await dbToday();
  const fields = await loadFields();
  const facts = await usableFacts(caseId);
  const formulas = latestEffective((await q("SELECT * FROM uw_formulas WHERE status = 'approved'")).map(uwrepo.mapFormula), day);
  const defs = latestEffective((await q("SELECT * FROM uw_recon_defs WHERE status = 'approved'")).map(uwrepo.mapReconDef), day);
  const rules = latestEffective((await q("SELECT * FROM uw_rules WHERE status = 'approved'")).map(uwrepo.mapRule), day)
    .filter((r) => r.threshold != null);

  const prevRun = await latestRunId(caseId);
  const previous = prevRun ? (await q('SELECT * FROM uw_recon_results WHERE run_id = ?', [prevRun])).map(uwrepo.mapRecon) : [];

  const calcs = computeFormulas(formulas, facts, fields);
  const recons = computeRecons(defs, facts, fields, previous);
  const ctx = {
    case: c, facts, calcs, recons,
    checks: (await q('SELECT * FROM uw_public_checks WHERE case_id = ?', [caseId])).map(uwrepo.mapCheck),
    checklist: await checklist.compute(c),
    bank: await bank.analyse(caseId)
  };
  const ruleResults = await evaluateRules(rules, ctx);

  const versions = {
    formulas: formulas.map((f) => ({ code: f.code, version: f.version, id: f.id })),
    reconciliations: defs.map((d) => ({ code: d.code, version: d.version, id: d.id })),
    rules: rules.map((r) => ({ code: r.code, version: r.version, id: r.id }))
  };

  return tx(async (cx) => {
    // input_seq is the case's change counter as read before any data was loaded,
    // so a change made while this run was computing leaves the case stale.
    const ins = await cx.q('INSERT INTO uw_runs (case_id, revision, trigger_reason, include_provisional, input_seq, versions, created_by_id, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [caseId, c.revision, String(reason).slice(0, 190), 1, c.changeSeq, JSON.stringify(versions), user ? user.id : null, user ? user.name : 'system']);
    const runId = ins.insertId;
    for (const r of calcs) {
      await cx.q(
        `INSERT INTO uw_calc_results (run_id, case_id, formula_id, formula_code, formula_version, period_start, period_end, basis,
           status, provisional, value, numerator, denominator, input_fact_ids, rationale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [runId, caseId, r.formulaId, r.formulaCode, r.formulaVersion, r.periodStart, r.periodEnd, r.basis, r.status,
          r.provisional ? 1 : 0, r.value || null, r.numerator || null, r.denominator || null, JSON.stringify(r.inputFactIds), r.rationale.slice(0, 1000)]);
    }
    for (const r of recons) {
      await cx.q(
        `INSERT INTO uw_recon_results (run_id, case_id, def_id, def_code, def_version, period_start, period_end, left_fact_ids,
           right_fact_ids, left_paise, right_paise, gap_paise, gap_pct, tolerance_pct, tolerance_abs_paise, comparable_basis,
           outcome, rationale, input_signature, resolution, explanation, evidence_refs, resolved_by, resolved_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [runId, caseId, r.defId, r.defCode, r.defVersion, r.periodStart, r.periodEnd, JSON.stringify(r.leftFactIds),
          JSON.stringify(r.rightFactIds), r.leftPaise || null, r.rightPaise || null, r.gapPaise || null, r.gapPct || null,
          r.tolerancePct, r.toleranceAbsPaise, r.comparableBasis.slice(0, 190), r.outcome, (r.rationale || '').slice(0, 1000),
          r.inputSignature, r.resolution || 'none', r.explanation || null, r.evidenceRefs ? JSON.stringify(r.evidenceRefs) : null,
          r.resolvedBy || null, r.resolvedAt ? String(r.resolvedAt).replace('T', ' ').slice(0, 23) : null]);
    }
    for (const r of ruleResults) {
      await cx.q(
        'INSERT INTO uw_rule_results (run_id, case_id, rule_id, rule_code, rule_version, rule_class, metric, metric_value, outcome, detail) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [runId, caseId, r.ruleId, r.ruleCode, r.ruleVersion, r.ruleClass, r.metric, r.metricValue, r.outcome, r.detail.slice(0, 1000)]);
    }
    return runId;
  });
}

async function results(caseId) {
  const runId = await latestRunId(caseId);
  if (!runId) return { run: null, calcs: [], recons: [], rules: [] };
  const [runRow] = await q('SELECT * FROM uw_runs WHERE id = ?', [runId]);
  return {
    run: { id: runRow.id, revision: runRow.revision, inputSeq: runRow.input_seq, reason: runRow.trigger_reason, versions: uwrepo.j(runRow.versions), createdBy: runRow.created_by, createdAt: uwrepo.iso(runRow.created_at) },
    calcs: (await q('SELECT * FROM uw_calc_results WHERE run_id = ? ORDER BY formula_code, period_end, basis', [runId])).map(uwrepo.mapCalc),
    recons: (await q('SELECT * FROM uw_recon_results WHERE run_id = ? ORDER BY def_code, period_end', [runId])).map(uwrepo.mapRecon),
    rules: (await q('SELECT * FROM uw_rule_results WHERE run_id = ? ORDER BY FIELD(rule_class,\'hard_stop\',\'committee_exception\',\'warning\'), rule_code', [runId])).map(uwrepo.mapRuleResult)
  };
}

module.exports = {
  run, results, latestRunId, loadFields, usableFacts, latestEffective, effective, dbToday,
  validateFormulaDef, validateReconDef, validateRule, parseMetric, compare, runRuleTests,
  computeFormulas, computeRecons, FORMATS
};
