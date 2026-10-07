'use strict';
/* ============================================================================
   Monitoring — the early-warning rules, the renewal gates and the site-visit
   cadence. All of them are computed off the book as it stands; none is asserted
   by a person.

   Alerts are idempotent: each rule owns a key per borrower, so a condition that
   is still true tomorrow refreshes the alert it already raised (updating the live
   numbers in its wording) rather than stacking a second one, and severity only
   ever ratchets upward. Nothing closes itself — an alert is resolved by a person
   with a written account — with two mechanical exceptions: logging a visit closes
   the visit alert, and filing a month closes the missing-MIS alert, because those
   are precisely what was asked for.
   ========================================================================== */
const { q } = require('./db/pool');
const repo = require('./repo');
const calc = require('./calc');
const book = require('./book');
const policy = require('./policy');

const VISIT_CADENCE_DAYS = 92;
const SEV_RANK = { low: 1, medium: 2, high: 3 };
const daysBetween = (from, to) => Math.round((new Date(to) - new Date(from)) / 86400000);

/* ---------------- shared data ---------------- */
async function lastVisits() {
  const rows = await q('SELECT borrower_id, MAX(visit_date) AS last FROM site_visits GROUP BY borrower_id');
  return new Map(rows.map((r) => [r.borrower_id, String(r.last).slice(0, 10)]));
}
async function misByBorrower() {
  const rows = await q('SELECT * FROM borrower_mis ORDER BY month DESC');
  const m = new Map();
  rows.forEach((r) => { (m.get(r.borrower_id) || m.set(r.borrower_id, []).get(r.borrower_id)).push(r); });
  return m;
}
const runwayOf = (r) => (r && +r.burn > 0 ? +(+r.closing_cash / +r.burn).toFixed(1) : null);

/* ---------------- site visits ---------------- */
function cadenceFor(store, visits, today = calc.td()) {
  const out = store.borrowers.filter((b) => b.status === 'active').map((b) => {
    const open = store.drawdowns.filter((d) => d.borrowerId === b.id && d.status !== 'Repaid');
    const outstanding = calc.money(open.reduce((s, d) => s + (+d.outPrin || 0), 0));
    const last = visits.get(b.id) || null;
    const since = last ? daysBetween(last, today) : null;
    // Never visited: the clock starts when the first money went out.
    const clockStart = last || open.map((d) => d.bankDebit).sort()[0] || null;
    const clock = clockStart ? daysBetween(clockStart, today) : 0;
    return { borrowerId: b.id, name: b.name, outstanding, lastVisit: last, daysSince: since,
      due: outstanding > 0.5 && clock > VISIT_CADENCE_DAYS };
  });
  return out.sort((a, b) => (b.due - a.due) || (b.outstanding - a.outstanding) || a.name.localeCompare(b.name));
}

/* ---------------- renewal gates ---------------- */
async function highAlertBorrowers(days = 183, today = calc.td()) {
  const since = new Date(new Date(today).getTime() - days * 86400000).toISOString().slice(0, 10);
  const rows = await q("SELECT DISTINCT borrower_id FROM ews_alerts WHERE severity = 'high' AND created_at >= ?", [since]);
  return new Set(rows.map((r) => r.borrower_id));
}

function renewalGates(b, store, highSet, today = calc.td()) {
  const open = store.drawdowns.filter((d) => d.borrowerId === b.id && d.status !== 'Repaid');
  const overdue = open.filter((d) => d.loanType !== 'io' && calc.poAccrued(d, b, today).odD > 0);
  const outstanding = open.reduce((s, d) => s + (+d.outPrin || 0), 0);
  const limit = calc.currentLimit(store, b.id);
  const util = limit > 0 ? outstanding / limit * 100 : 0;
  return [
    { key: 'overdue', label: 'No tranche past its tenure', pass: overdue.length === 0,
      detail: overdue.length ? overdue.length + ' tranche(s) overdue: ' + overdue.map((d) => d.ref || '#' + d.id).join(', ') : 'Every open tranche is inside its tenure.' },
    { key: 'ews', label: 'No high-severity alert in the last 183 days', pass: !highSet.has(b.id),
      detail: highSet.has(b.id) ? 'A high-severity early-warning alert was raised inside the last six months.' : 'No high-severity alerts in the last six months.' },
    { key: 'stop', label: 'No drawdown stop in force', pass: !b.stopDrawdowns,
      detail: b.stopDrawdowns ? 'Drawdowns are stopped' + (b.stopReason ? ': ' + b.stopReason : '.') : 'No stop has been placed.' },
    { key: 'util', label: 'Utilisation at or below 100% of the limit', pass: util <= 100.0001,
      detail: 'Drawn ' + util.toFixed(1) + '% of ' + policy.inrShort(limit) + '.' }
  ];
}

/* Facilities inside forty-five days of their review date, or past it. */
function dueForReview(store, highSet, today = calc.td()) {
  const out = [];
  store.borrowers.filter((b) => b.status === 'active').forEach((b) => {
    const r = calc.renewalStatus(store, b.id);
    if (!r || r.daysLeft > 45) return;
    const outstanding = store.drawdowns.filter((d) => d.borrowerId === b.id && d.status !== 'Repaid')
      .reduce((s, d) => s + (+d.outPrin || 0), 0);
    out.push({ borrowerId: b.id, name: b.name, rate: b.rate, product: b.product, outstanding: calc.money(outstanding),
      renewDate: r.renewDate, daysLeft: r.daysLeft, status: r.status, gates: renewalGates(b, store, highSet, today) });
  });
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

/* ---------------- the early-warning rules ---------------- */
function evaluate(store, visits, mis, today = calc.td(), onlyBorrowerId = null) {
  const found = [];
  const prevMonth = book.previousMonth(new Date(today + 'T00:00:00Z'));
  const dayOfMonth = +today.slice(8, 10);
  const cadence = new Map(cadenceFor(store, visits, today).map((c) => [c.borrowerId, c]));

  store.borrowers.filter((b) => b.status === 'active' && (!onlyBorrowerId || b.id === onlyBorrowerId)).forEach((b) => {
    const add = (ruleKey, severity, message) => found.push({ borrowerId: b.id, ruleKey, severity, message });
    const open = store.drawdowns.filter((d) => d.borrowerId === b.id && d.status !== 'Repaid');
    const outstanding = open.reduce((s, d) => s + (+d.outPrin || 0), 0);
    const limit = calc.currentLimit(store, b.id);

    // 1 — overdue tranche
    const overdue = open.filter((d) => d.loanType !== 'io').map((d) => ({ d, odD: calc.poAccrued(d, b, today).odD })).filter((x) => x.odD > 0);
    if (overdue.length) {
      const worst = overdue.sort((a, c) => c.odD - a.odD)[0];
      add('overdue', worst.odD > 30 ? 'high' : 'medium',
        b.name + ': ' + (overdue.length > 1 ? overdue.length + ' tranches are past tenure — worst is ' : '') + (worst.d.ref || 'tranche #' + worst.d.id) +
        ' at ' + worst.odD + ' day(s) overdue (' + policy.inr(worst.d.outPrin) + ' outstanding).');
    }
    // 2 — utilisation
    if (limit > 0) {
      const util = outstanding / limit * 100;
      if (util >= 95) add('utilisation', util >= 100 ? 'high' : 'medium', b.name + ' has drawn ' + util.toFixed(1) + '% of its ' + policy.inrShort(limit) + ' sanctioned limit.');
    }
    // 3 — review overdue
    const rv = calc.renewalStatus(store, b.id);
    if (rv && rv.status === 'overdue') add('review', 'medium', b.name + ': the annual review was due on ' + rv.renewDate + ' (' + Math.abs(rv.daysLeft) + ' day(s) ago).');
    // 4 — site visit due
    const c = cadence.get(b.id);
    if (c && c.due) add('visit', 'low', b.name + ' has ' + policy.inrShort(c.outstanding) + ' out and ' + (c.lastVisit ? 'was last visited ' + c.daysSince + ' days ago' : 'has never been visited') + ' — a visit is due every ' + VISIT_CADENCE_DAYS + ' days.');

    const rows = mis.get(b.id) || [];
    // 5 — MIS missing (Rocket Fuel owes last month within ten days of it ending)
    if (b.product === 'rocket_fuel' && dayOfMonth > 10 && String(b.sanctionDate).slice(0, 7) <= prevMonth && !rows.some((r) => r.month === prevMonth)) {
      add('mis_missing', 'medium', b.name + ' has not filed its MIS for ' + prevMonth + ' — a missing month blocks the next drawdown.');
    }
    if (rows.length) {
      const latest = rows[0];
      // 6 — revenue drop against the trailing three months
      const prior = rows.slice(1, 4);
      if (prior.length === 3) {
        const avg = prior.reduce((s, r) => s + +r.revenue, 0) / 3;
        if (avg > 0 && +latest.revenue < avg * 0.8) {
          add('revenue_drop', 'high', b.name + ': revenue for ' + latest.month + ' was ' + policy.inrShort(latest.revenue) + ', ' +
            Math.round((1 - +latest.revenue / avg) * 100) + '% below the trailing three-month average of ' + policy.inrShort(avg) + '.');
        }
      }
      // 7 — runway
      const rw = runwayOf(latest);
      if (rw != null && rw < 6) add('runway', rw < 3 ? 'high' : 'medium', b.name + ' reported ' + rw + ' months of runway for ' + latest.month + ' — below the six-month floor.');
    }
  });
  return found;
}

/* Run the rules and raise, refresh or leave alone. Returns how many alerts are new. */
async function scan({ borrowerId = null, today = calc.td() } = {}) {
  const [store, visits, mis] = await Promise.all([repo.loadEngineStore(), lastVisits(), misByBorrower()]);
  const hits = evaluate(store, visits, mis, today, borrowerId);
  let raised = 0, refreshed = 0;
  for (const h of hits) {
    const live = await q(
      "SELECT id, severity FROM ews_alerts WHERE borrower_id = ? AND rule_key = ? AND status <> 'resolved' ORDER BY id DESC LIMIT 1", [h.borrowerId, h.ruleKey]);
    if (live.length) {
      const sev = SEV_RANK[h.severity] > SEV_RANK[live[0].severity] ? h.severity : live[0].severity;   // ratchets up only
      await q('UPDATE ews_alerts SET message = ?, severity = ? WHERE id = ?', [h.message, sev, live[0].id]);
      refreshed++;
      continue;
    }
    // A person resolved this very rule in the last week — give the resolution time to take effect.
    const recent = await q(
      "SELECT id FROM ews_alerts WHERE borrower_id = ? AND rule_key = ? AND status = 'resolved' AND resolved_at > NOW(3) - INTERVAL 7 DAY LIMIT 1",
      [h.borrowerId, h.ruleKey]);
    if (recent.length) continue;
    await q("INSERT INTO ews_alerts (borrower_id, rule_key, auto, severity, message, raised_by) VALUES (?,?,1,?,?, 'Rules')",
      [h.borrowerId, h.ruleKey, h.severity, h.message]);
    raised++;
  }
  return { raised, refreshed, checked: hits.length };
}

module.exports = {
  VISIT_CADENCE_DAYS, lastVisits, misByBorrower, runwayOf, cadenceFor, highAlertBorrowers, renewalGates, dueForReview,
  evaluate, scan
};
