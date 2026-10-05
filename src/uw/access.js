'use strict';
/* ============================================================================
   Who may do what in underwriting (spec §9, §10, §11), and the case lifecycle
   helpers every route shares.

     Maker (analyst work)       analyst, manager, director
     Checker                    manager, director — never the submitter
     Sanction authority         director — never the submitter, and not the
                                checker unless no other active Director exists
     Credit Logic Book edits    manager, director (two distinct approvals)
     Module settings            director

   Note the difference from lending operations, where the Analyst role is
   read-only: in underwriting the analyst is the maker.
   ========================================================================== */
const { q } = require('../db/pool');
const auth = require('../auth');
const uwrepo = require('./repo');
const { EDITABLE_STATUSES } = require('./vocab');

const fail = (status, message) => Object.assign(new Error(message), { status });

const requireMaker = (req) => auth.requireUser(req);
function requireChecker(req) {
  const u = auth.requireUser(req);
  if (!['manager', 'director'].includes(u.role)) throw fail(403, 'Only a Manager or Director can act as checker.');
  return u;
}
function requireSanction(req) {
  const u = auth.requireUser(req);
  if (u.role !== 'director') throw fail(403, 'Only a Director holds sanction authority.');
  return u;
}
function requireBookEditor(req) {
  const u = auth.requireUser(req);
  if (!['manager', 'director'].includes(u.role)) throw fail(403, 'Only a Manager or Director can change the Credit Logic Book.');
  return u;
}
const requireDirector = (req) => auth.requireDirector(req);

async function loadCase(id) {
  const c = await uwrepo.getCase(id);
  if (!c) throw fail(404, 'Case not found.');
  return c;
}

function assertEditable(c) {
  if (!EDITABLE_STATUSES.includes(c.status)) {
    const why = c.status === 'submitted' || c.status === 'recommended'
      ? 'it is with the ' + (c.status === 'submitted' ? 'checker' : 'sanction authority') + ' (the submitted snapshot is frozen). Upload new evidence to start a new revision, or ask for it to be sent back.'
      : 'it has been decided (' + c.status.replace(/_/g, ' ') + '). Open a new case linked to this one.';
    throw fail(409, 'This case cannot be changed: ' + why);
  }
}

/* Record that something the analysis depends on changed, then re-run it.
   If the re-run fails the case stays visibly stale (readiness compares the
   run's input_seq with the case's change_seq) — the change is never lost and
   never silently treated as analysed. */
async function changed(caseId, user, reason) {
  await q('UPDATE uw_cases SET change_seq = change_seq + 1 WHERE id = ?', [caseId]);
  try {
    const engine = require('./engine');
    await engine.run(caseId, { reason, user });
    return { analysis: 'current' };
  } catch (e) {
    console.error('[uw] analysis re-run failed for case ' + caseId + ':', e);
    return { analysis: 'stale', analysisError: e.message };
  }
}

/* Re-run every case still being worked, e.g. after the Credit Logic Book or
   a bank rule changed. Frozen and decided cases keep their snapshot. */
async function rerunOpenCases(user, reason, { reclassifyBank = false } = {}) {
  const rows = await q('SELECT id FROM uw_cases WHERE status IN (?)', [EDITABLE_STATUSES]);
  for (const r of rows) {
    if (reclassifyBank) await require('./bank').reclassify(r.id);
    await changed(r.id, user, reason);
  }
  return rows.length;
}

async function activeDirectorsOtherThan(ids) {
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM users WHERE role = 'director' AND active = 1 AND id NOT IN (?)", [ids.length ? ids : [0]]);
  return Number(n);
}

module.exports = {
  requireMaker, requireChecker, requireSanction, requireBookEditor, requireDirector,
  loadCase, assertEditable, changed, rerunOpenCases, activeDirectorsOtherThan, fail
};
