'use strict';
/* Facts, analysis runs, reconciliation explanations and policy dispositions
   (spec §3, §5, §8.2, §9, §10 "Evidence review", "Analysis", "Policy"). */
const express = require('express');
const { q } = require('../../db/pool');
const audit = require('../../audit');
const uwrepo = require('../../uw/repo');
const access = require('../../uw/access');
const facts = require('../../uw/facts');
const engine = require('../../uw/engine');
const { H, bad, notFound, reqStr, reqId, oneOf } = require('../../http');

const router = express.Router();

/* ---------------- facts ---------------- */
router.get('/cases/:id/facts', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  return facts.list(c.id, { all: req.query.all === '1' });
}));

router.post('/cases/:id/facts', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const f = await facts.create(c.id, req.body, me);
  await audit.log(req, 'uw.fact.create', 'uw_case', c.id,
    me.name + ' recorded ' + f.fieldCode + ' = ' + f.rawValue + (f.originalUnit && f.originalUnit !== 'INR' ? ' ' + f.originalUnit : '') + ' (' + f.basis + ')',
    { factId: f.id, after: f });
  return Object.assign({ fact: f }, await access.changed(c.id, me, 'fact recorded'));
}));

router.post('/cases/:id/facts/:fid/correct', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const r = await facts.correct(c.id, reqId(req.params.fid, 'Fact'), req.body, me);
  await audit.log(req, 'uw.fact.correct', 'uw_case', c.id,
    me.name + ' corrected fact #' + r.before.id + ' → #' + r.after.id + ': ' + r.after.correctionReason, { before: r.before, after: r.after });
  return Object.assign({ fact: r.after }, await access.changed(c.id, me, 'fact corrected'));
}));

router.post('/cases/:id/facts/:fid/review', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const status = oneOf(req.body.status, 'Review status', ['approved', 'provisional', 'rejected']);
  const r = await facts.review(c.id, reqId(req.params.fid, 'Fact'), { status, note: req.body.note }, me);
  await audit.log(req, 'uw.fact.review', 'uw_case', c.id, me.name + ' marked fact #' + r.after.id + ' ' + status,
    { factId: r.after.id, from: r.before.reviewStatus, to: status, note: req.body.note || '' });
  return Object.assign({ fact: r.after }, await access.changed(c.id, me, 'fact reviewed'));
}));

router.get('/cases/:id/facts/:fid/history', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  return facts.history(c.id, reqId(req.params.fid, 'Fact'));
}));

/* ---------------- analysis ---------------- */
router.post('/cases/:id/run', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const runId = await engine.run(c.id, { reason: 'manual re-run', user: me });
  await audit.log(req, 'uw.analysis.run', 'uw_case', c.id, me.name + ' re-ran the analysis on ' + c.caseCode, { runId });
  return engine.results(c.id);
}));

router.get('/cases/:id/results', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const res = await engine.results(c.id);
  const dispositions = (await q('SELECT * FROM uw_rule_dispositions WHERE case_id = ? AND revision = ? ORDER BY id', [c.id, c.revision])).map(uwrepo.mapDisposition);
  const ids = Array.from(new Set(res.rules.map((r) => r.ruleId)));
  const rules = ids.length ? (await q('SELECT * FROM uw_rules WHERE id IN (?)', [ids])).map(uwrepo.mapRule) : [];
  const fIds = Array.from(new Set(res.calcs.map((r) => r.formulaId)));
  const formulas = fIds.length ? (await q('SELECT * FROM uw_formulas WHERE id IN (?)', [fIds])).map(uwrepo.mapFormula) : [];
  const dIds = Array.from(new Set(res.recons.map((r) => r.defId)));
  const defs = dIds.length ? (await q('SELECT * FROM uw_recon_defs WHERE id IN (?)', [dIds])).map(uwrepo.mapReconDef) : [];
  return Object.assign(res, { dispositions, ruleDefs: rules, formulaDefs: formulas, reconDefs: defs, stale: !res.run || res.run.inputSeq !== c.changeSeq });
}));

/* Every reference must point at something on this case. */
async function checkRefs(caseId, refs) {
  if (!Array.isArray(refs)) throw bad('Evidence references must be a list.');
  const TABLE = { fact: 'uw_facts', doc: 'uw_document_versions', txn: 'uw_transactions', check: 'uw_public_checks' };
  const out = [];
  for (const r of refs.slice(0, 50)) {
    const table = TABLE[r && r.type];
    const id = Number(r && r.id);
    if (!table || !Number.isInteger(id) || id <= 0) throw bad('Each evidence reference needs a type (fact, doc, txn, check) and an id.');
    const hit = await q('SELECT id FROM ' + table + ' WHERE id = ? AND case_id = ?', [id, caseId]);
    if (!hit.length) throw bad(r.type + ' #' + id + ' is not on this case.');
    out.push({ type: r.type, id });
  }
  return out;
}

router.post('/cases/:id/recons/:rid/resolve', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const runId = await engine.latestRunId(c.id);
  const rows = await q('SELECT * FROM uw_recon_results WHERE id = ? AND case_id = ?', [reqId(req.params.rid, 'Reconciliation'), c.id]);
  if (!rows.length) throw notFound('Reconciliation not found.');
  if (rows[0].run_id !== runId) throw bad('That result is from an earlier run — reload and resolve the current one.');
  const before = uwrepo.mapRecon(rows[0]);
  const resolution = oneOf(req.body.resolution, 'Resolution', ['explained', 'unresolved', 'none']);
  const explanation = resolution === 'none' ? null : reqStr(req.body.explanation, 'Explanation', { max: 4000 });
  const refs = resolution === 'none' ? [] : await checkRefs(c.id, req.body.evidenceRefs || []);
  // Spec §5: an explanation without supporting evidence stays unresolved.
  if (resolution === 'explained' && !refs.length) throw bad('An explanation needs at least one piece of supporting evidence; otherwise record it as unresolved.');
  await q('UPDATE uw_recon_results SET resolution = ?, explanation = ?, evidence_refs = ?, resolved_by = ?, resolved_at = IF(? = \'none\', NULL, NOW(3)) WHERE id = ?',
    [resolution, explanation, refs.length ? JSON.stringify(refs) : null, resolution === 'none' ? null : me.name, resolution, before.id]);
  const after = uwrepo.mapRecon((await q('SELECT * FROM uw_recon_results WHERE id = ?', [before.id]))[0]);
  await audit.log(req, 'uw.recon.resolve', 'uw_case', c.id, me.name + ' marked ' + before.defCode + ' (' + before.periodEnd + ') ' + resolution,
    { reconId: before.id, before: { resolution: before.resolution, explanation: before.explanation }, after: { resolution, explanation, evidenceRefs: refs } });
  // Rules can depend on unexplained reconciliations.
  return Object.assign({ recon: after }, await access.changed(c.id, me, 'reconciliation resolution'));
}));

/* ---------------- policy dispositions ---------------- */
router.post('/cases/:id/rules/:code/disposition', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const kind = oneOf(req.body.kind, 'Kind', ['override', 'exception_review']);
  const rationale = reqStr(req.body.rationale, 'Rationale', { max: 4000 });
  const res = await engine.results(c.id);
  const result = res.rules.find((r) => r.ruleCode === req.params.code);
  if (!result) throw notFound('That rule is not in the latest analysis run.');
  if (result.outcome === 'not_triggered') throw bad('The rule is not triggered — nothing to disposition.');
  const [rule] = await q('SELECT * FROM uw_rules WHERE id = ?', [result.ruleId]);

  let reviewer = null;
  if (kind === 'override') {
    // Spec §9: a hard stop blocks submission unless an authorised policy
    // mechanism explicitly allows override.
    if (result.ruleClass !== 'hard_stop') throw bad('Only hard stops are overridden; committee exceptions get a reviewer.');
    if (!rule.overridable) throw bad('This hard stop is not overridable under the approved policy.');
    if (me.role !== 'director') throw Object.assign(new Error('Only a Director can override a hard stop.'), { status: 403 });
    reviewer = { id: me.id, name: me.name };
  } else {
    if (result.ruleClass !== 'committee_exception') throw bad('Reviewer assignment applies to committee exceptions.');
    const rid = reqId(req.body.reviewerId, 'Reviewer');
    const u = await q("SELECT id, name FROM users WHERE id = ? AND active = 1 AND role IN ('director','manager')", [rid]);
    if (!u.length) throw bad('The reviewer must be an active Manager or Director.');
    reviewer = u[0];
  }
  await q(
    `INSERT INTO uw_rule_dispositions (case_id, revision, rule_code, rule_version, kind, reviewer_id, reviewer_name, rationale, created_by_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE reviewer_id = VALUES(reviewer_id), reviewer_name = VALUES(reviewer_name), rationale = VALUES(rationale),
                             created_by_id = VALUES(created_by_id), created_by = VALUES(created_by), created_at = NOW(3)`,
    [c.id, c.revision, result.ruleCode, result.ruleVersion, kind, reviewer.id, reviewer.name, rationale, me.id, me.name]);
  await audit.log(req, 'uw.rule.' + kind, 'uw_case', c.id,
    me.name + (kind === 'override' ? ' overrode hard stop ' : ' assigned ' + reviewer.name + ' to exception ') + result.ruleCode + ' v' + result.ruleVersion,
    { rule: result.ruleCode, version: result.ruleVersion, outcome: result.outcome, reviewer: reviewer.name, rationale });
  return { ok: true };
}));

router.delete('/cases/:id/rules/:code/disposition/:kind', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const kind = oneOf(req.params.kind, 'Kind', ['override', 'exception_review']);
  if (kind === 'override' && me.role !== 'director') throw Object.assign(new Error('Only a Director can withdraw an override.'), { status: 403 });
  const r = await q('DELETE FROM uw_rule_dispositions WHERE case_id = ? AND revision = ? AND rule_code = ? AND kind = ?', [c.id, c.revision, req.params.code, kind]);
  if (r.affectedRows) await audit.log(req, 'uw.rule.' + kind + '.withdraw', 'uw_case', c.id, me.name + ' withdrew the ' + kind.replace('_', ' ') + ' on ' + req.params.code);
  return { ok: true };
}));

module.exports = router;
