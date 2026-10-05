'use strict';
/* Investigation: public check tasks, the claim ledger and borrower questions
   (spec §7, §10 "Investigation"). Phase 1 performs no automated website
   access: every check is an analyst task with a recorded outcome. */
const express = require('express');
const { q } = require('../../db/pool');
const audit = require('../../audit');
const uwrepo = require('../../uw/repo');
const access = require('../../uw/access');
const vocab = require('../../uw/vocab');
const { H, bad, notFound, reqStr, optStr, reqId, optId, oneOf } = require('../../http');

const router = express.Router();

const CHECK_SELECT = 'SELECT pc.*, s.name AS source_name FROM uw_public_checks pc JOIN uw_sources s ON s.id = pc.source_id';

router.get('/cases/:id/checks', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  return (await q(CHECK_SELECT + ' WHERE pc.case_id = ? ORDER BY pc.id', [c.id])).map(uwrepo.mapCheck);
}));

router.post('/cases/:id/checks', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const sourceId = reqId(req.body.sourceId, 'Source');
  const s = await q('SELECT id, name FROM uw_sources WHERE id = ? AND active = 1', [sourceId]);
  if (!s.length) throw bad('Unknown or inactive source.');
  const terms = reqStr(req.body.searchTerms, 'Search terms', { max: 500 });
  const assignedTo = optId(req.body.assignedToId, 'Assignee');
  const r = await q('INSERT INTO uw_public_checks (case_id, source_id, search_terms, assigned_to_id, created_by) VALUES (?,?,?,?,?)',
    [c.id, sourceId, terms, assignedTo, me.name]);
  await audit.log(req, 'uw.check.create', 'uw_case', c.id, me.name + ' added a ' + s[0].name + ' check for "' + terms + '"', { checkId: r.insertId });
  return Object.assign({ check: uwrepo.mapCheck((await q(CHECK_SELECT + ' WHERE pc.id = ?', [r.insertId]))[0]) }, await access.changed(c.id, me, 'public check added'));
}));

/* Record the outcome. Spec §7: preserve URL, title, time, query and a
   snapshot or analyst attestation; an access failure is "failed" or "manual
   review required", never clear. */
router.post('/cases/:id/checks/:cid/complete', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const rows = await q(CHECK_SELECT + ' WHERE pc.id = ? AND pc.case_id = ?', [reqId(req.params.cid, 'Check'), c.id]);
  if (!rows.length) throw notFound('Check not found.');
  const before = uwrepo.mapCheck(rows[0]);

  const status = oneOf(req.body.status, 'Outcome', ['match_found', 'no_match', 'failed', 'manual_review_required']);
  const queryUsed = optStr(req.body.queryUsed, 'Query used', { max: 500 });
  const resultUrl = optStr(req.body.resultUrl, 'Result URL', { max: 1000 });
  const resultTitle = optStr(req.body.resultTitle, 'Result title', { max: 500 });
  const note = optStr(req.body.analystNote, 'Analyst note', { max: 4000 });
  const snapshotVersionId = optId(req.body.snapshotVersionId, 'Snapshot');
  const confidence = req.body.matchConfidence ? oneOf(req.body.matchConfidence, 'Match confidence', vocab.MATCH_CONFIDENCE) : null;
  const critical = !!req.body.critical;
  // Wall-clock time as the analyst entered it; defaults to the server's now.
  let searchedAt = null;
  if (req.body.searchedAt) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(String(req.body.searchedAt).trim());
    if (!m || isNaN(new Date(m[1] + 'T' + m[2] + ':00Z').getTime())) throw bad('Searched-at must be a date and time (YYYY-MM-DD HH:MM).');
    searchedAt = m[1] + ' ' + m[2] + (m[3] || ':00');
  }

  if (resultUrl && !/^https?:\/\//i.test(resultUrl)) throw bad('Result URL must start with http:// or https://.');
  if (snapshotVersionId) {
    const v = await q("SELECT id FROM uw_document_versions WHERE id = ? AND case_id = ? AND intake_status = 'accepted'", [snapshotVersionId, c.id]);
    if (!v.length) throw bad('The snapshot must be an accepted file on this case.');
  }
  if (status === 'match_found' || status === 'no_match') {
    if (!queryUsed) throw bad('Record the exact query used.');
    if (!snapshotVersionId && !note) throw bad('Attach a snapshot of the result or write an attestation of what was seen.');
  }
  if (status === 'match_found') {
    if (!resultUrl || !resultTitle) throw bad('A match needs the result URL and title.');
    if (!confidence || confidence === 'none') throw bad('Say how confident the identity match is.');
  }
  if ((status === 'failed' || status === 'manual_review_required') && !note) throw bad('Say what happened (e.g. site unavailable, CAPTCHA, login required).');
  if (critical && status !== 'match_found') throw bad('Only a found match can be marked as a critical event.');

  await q(
    `UPDATE uw_public_checks SET status = ?, searched_at = ?, query_used = ?, result_url = ?, result_title = ?, snapshot_version_id = ?,
            analyst_note = ?, match_confidence = ?, critical = ?, completed_by = ? WHERE id = ?`,
    [status, searchedAt || { toSqlString: () => 'NOW(3)' }, queryUsed, resultUrl, resultTitle,
      snapshotVersionId, note || null, status === 'match_found' ? confidence : (confidence || null), critical ? 1 : 0, me.name, before.id]);
  const after = uwrepo.mapCheck((await q(CHECK_SELECT + ' WHERE pc.id = ?', [before.id]))[0]);
  await audit.log(req, 'uw.check.complete', 'uw_case', c.id, me.name + ' recorded ' + before.sourceName + ' check as ' + status.replace(/_/g, ' '), { checkId: before.id, before, after });
  return Object.assign({ check: after }, await access.changed(c.id, me, 'public check recorded'));
}));

/* ---------------- claims ---------------- */
async function checkRefs(caseId, refs) {
  if (!Array.isArray(refs)) throw bad('Evidence references must be a list.');
  const TABLE = { fact: 'uw_facts', doc: 'uw_document_versions', txn: 'uw_transactions', check: 'uw_public_checks' };
  const out = [];
  for (const r of refs.slice(0, 50)) {
    const table = TABLE[r && r.type];
    const id = Number(r && r.id);
    if (!table || !Number.isInteger(id) || id <= 0) throw bad('Each evidence reference needs a type (fact, doc, txn, check) and an id.');
    if (!(await q('SELECT id FROM ' + table + ' WHERE id = ? AND case_id = ?', [id, caseId])).length) throw bad(r.type + ' #' + id + ' is not on this case.');
    out.push({ type: r.type, id });
  }
  return out;
}

function readClaim(b) {
  const supportState = oneOf(b.supportState, 'Support', vocab.SUPPORT_STATES, 'unverified');
  return {
    category: reqStr(b.category, 'Category', { max: 48 }), statement: reqStr(b.statement, 'Claim', { max: 4000 }),
    supportState, uncertainty: optStr(b.uncertainty, 'Uncertainty', { max: 500 })
  };
}

router.get('/cases/:id/claims', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  return (await q('SELECT * FROM uw_claims WHERE case_id = ? ORDER BY id', [c.id])).map(uwrepo.mapClaim);
}));

router.post('/cases/:id/claims', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const cl = readClaim(req.body);
  const refs = await checkRefs(c.id, req.body.evidenceRefs || []);
  if (['supported', 'partially_supported', 'contradicted'].includes(cl.supportState) && !refs.length) throw bad('Cite the evidence for a ' + cl.supportState.replace('_', ' ') + ' claim.');
  const r = await q('INSERT INTO uw_claims (case_id, category, statement, evidence_refs, support_state, uncertainty, created_by) VALUES (?,?,?,?,?,?,?)',
    [c.id, cl.category, cl.statement, JSON.stringify(refs), cl.supportState, cl.uncertainty, me.name]);
  await audit.log(req, 'uw.claim.create', 'uw_case', c.id, me.name + ' recorded a ' + cl.supportState + ' claim', { claimId: r.insertId, claim: cl, refs });
  return uwrepo.mapClaim((await q('SELECT * FROM uw_claims WHERE id = ?', [r.insertId]))[0]);
}));

router.put('/cases/:id/claims/:cid', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const rows = await q('SELECT * FROM uw_claims WHERE id = ? AND case_id = ?', [reqId(req.params.cid, 'Claim'), c.id]);
  if (!rows.length) throw notFound('Claim not found.');
  const before = uwrepo.mapClaim(rows[0]);
  const cl = readClaim(Object.assign({}, before, req.body));
  const refs = await checkRefs(c.id, req.body.evidenceRefs || before.evidenceRefs);
  if (['supported', 'partially_supported', 'contradicted'].includes(cl.supportState) && !refs.length) throw bad('Cite the evidence for a ' + cl.supportState.replace('_', ' ') + ' claim.');
  await q('UPDATE uw_claims SET category = ?, statement = ?, evidence_refs = ?, support_state = ?, uncertainty = ? WHERE id = ?',
    [cl.category, cl.statement, JSON.stringify(refs), cl.supportState, cl.uncertainty, before.id]);
  const after = uwrepo.mapClaim((await q('SELECT * FROM uw_claims WHERE id = ?', [before.id]))[0]);
  await audit.log(req, 'uw.claim.update', 'uw_case', c.id, me.name + ' updated claim #' + before.id, { before, after });
  return after;
}));

/* ---------------- borrower questions ---------------- */
router.get('/cases/:id/questions', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  return (await q('SELECT * FROM uw_questions WHERE case_id = ? ORDER BY id', [c.id])).map(uwrepo.mapQuestion);
}));

router.post('/cases/:id/questions', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const question = reqStr(req.body.question, 'Question', { max: 4000 });
  const refs = await checkRefs(c.id, req.body.relatedRefs || []);
  const r = await q('INSERT INTO uw_questions (case_id, question, related_refs, asked_by) VALUES (?,?,?,?)', [c.id, question, JSON.stringify(refs), me.name]);
  await audit.log(req, 'uw.question.create', 'uw_case', c.id, me.name + ' raised a borrower question', { questionId: r.insertId, question });
  return uwrepo.mapQuestion((await q('SELECT * FROM uw_questions WHERE id = ?', [r.insertId]))[0]);
}));

router.post('/cases/:id/questions/:qid/answer', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const rows = await q('SELECT * FROM uw_questions WHERE id = ? AND case_id = ?', [reqId(req.params.qid, 'Question'), c.id]);
  if (!rows.length) throw notFound('Question not found.');
  if (rows[0].status === 'closed') throw bad('This question is closed.');
  const response = reqStr(req.body.response, 'Response', { max: 8000 });
  const versionId = optId(req.body.responseVersionId, 'Response attachment');
  if (versionId && !(await q('SELECT id FROM uw_document_versions WHERE id = ? AND case_id = ?', [versionId, c.id])).length) throw bad('The attachment is not on this case.');
  await q("UPDATE uw_questions SET status = 'answered', response = ?, response_version_id = ?, answered_by = ?, answered_at = NOW(3) WHERE id = ?",
    [response, versionId, me.name, rows[0].id]);
  await audit.log(req, 'uw.question.answer', 'uw_case', c.id, me.name + ' recorded the borrower\'s response', { questionId: rows[0].id, before: uwrepo.mapQuestion(rows[0]), response, versionId });
  return uwrepo.mapQuestion((await q('SELECT * FROM uw_questions WHERE id = ?', [rows[0].id]))[0]);
}));

router.post('/cases/:id/questions/:qid/close', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const rows = await q('SELECT * FROM uw_questions WHERE id = ? AND case_id = ?', [reqId(req.params.qid, 'Question'), c.id]);
  if (!rows.length) throw notFound('Question not found.');
  await q("UPDATE uw_questions SET status = 'closed', closed_by = ?, closed_at = NOW(3) WHERE id = ?", [me.name, rows[0].id]);
  await audit.log(req, 'uw.question.close', 'uw_case', c.id, me.name + ' closed borrower question #' + rows[0].id);
  return uwrepo.mapQuestion((await q('SELECT * FROM uw_questions WHERE id = ?', [rows[0].id]))[0]);
}));

module.exports = router;
