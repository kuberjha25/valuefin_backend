'use strict';
/* Memo, submission, checker and sanction (spec §8.7, §9, §10 "Policy and
   memo", "Approval"). Analyst recommendation, checker comments and the
   sanction authority's decision are three separate records; none of them
   creates a disbursement instruction. */
const express = require('express');
const { q, tx } = require('../../db/pool');
const audit = require('../../audit');
const { notify } = require('../../notify');
const money = require('../../uw/money');
const uwrepo = require('../../uw/repo');
const access = require('../../uw/access');
const engine = require('../../uw/engine');
const memo = require('../../uw/memo');
const readiness = require('../../uw/readiness');
const snapshot = require('../../uw/snapshot');
const exporter = require('../../uw/exporter');
const vocab = require('../../uw/vocab');
const { H, bad, reqStr, reqId, optId, oneOf } = require('../../http');

const router = express.Router();
const SECTION_KEYS = vocab.MEMO_SECTIONS.map(([k]) => k);

/* ---------------- memo ---------------- */
router.get('/cases/:id/memo', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const m = await memo.getSections(c.id);
  return Object.assign(m, { validation: await memo.validate(c.id, m.sections) });
}));

router.put('/cases/:id/memo/:section', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const key = oneOf(req.params.section, 'Section', SECTION_KEYS);
  const body = String(req.body.body == null ? '' : req.body.body);
  if (body.length > 60000) throw bad('A memo section can be at most 60,000 characters.');
  const prev = await q('SELECT body FROM uw_memo_sections WHERE case_id = ? AND section_key = ?', [c.id, key]);
  await q('INSERT INTO uw_memo_sections (case_id, section_key, body, updated_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE body = VALUES(body), updated_by = VALUES(updated_by)',
    [c.id, key, body, me.name]);
  await audit.log(req, 'uw.memo.edit', 'uw_case', c.id, me.name + ' edited the memo section "' + key + '"',
    { section: key, beforeLength: prev.length ? prev[0].body.length : 0, afterLength: body.length });
  const m = await memo.getSections(c.id);
  return Object.assign(m, { validation: await memo.validate(c.id, m.sections) });
}));

/* Validate unsaved text — the editor calls this as the analyst types. */
router.post('/cases/:id/memo/validate', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const sections = {};
  for (const k of SECTION_KEYS) sections[k] = String((req.body.sections || {})[k] || '').slice(0, 60000);
  return memo.validate(c.id, sections);
}));

router.get('/cases/:id/memo/export', (req, res, next) => {
  Promise.resolve().then(async () => {
    const me = access.requireMaker(req);
    const c = await access.loadCase(reqId(req.params.id, 'Case'));
    const sid = optId(req.query.snapshot, 'Snapshot');
    let html;
    if (sid) {
      const s = await snapshot.get(sid, c.id);
      if (!s) throw Object.assign(new Error('Snapshot not found.'), { status: 404 });
      html = exporter.render(s.payload, { snapshotMeta: s });
    } else {
      html = exporter.render(await snapshot.build(c.id), { draft: true });
    }
    await audit.log(req, 'uw.memo.export', 'uw_case', c.id, me.name + ' exported the memo for ' + c.caseCode + (sid ? ' (snapshot ' + sid + ')' : ' (draft)'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.download === '1') res.setHeader('Content-Disposition', 'attachment; filename="' + c.caseCode + '-memo.html"');
    res.send(html);
  }).catch(next);
});

/* ---------------- submit (analyst → checker) ---------------- */
router.post('/cases/:id/submit', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const rationale = reqStr(req.body.rationale, 'Recommendation', { max: 8000 });

  // Always submit on a fresh run of the current evidence and Credit Logic Book.
  await engine.run(c.id, { reason: 'pre-submission run', user: me });
  const ready = await readiness.compute(c.id);
  if (!ready.ready) {
    const blocking = ready.gates.filter((g) => g.severity === 'block' && !g.ok).map((g) => g.message);
    throw Object.assign(new Error('Not ready to submit: ' + blocking.join(' | ')), { status: 400, gates: ready.gates });
  }
  const payload = await snapshot.build(c.id);

  const out = await tx(async (cx) => {
    const [row] = await cx.q('SELECT status, revision, change_seq FROM uw_cases WHERE id = ? FOR UPDATE', [c.id]);
    if (!vocab.EDITABLE_STATUSES.includes(row.status)) throw bad('The case changed state — reload.');
    if (row.change_seq !== payload.case.changeSeq) throw bad('Evidence changed while submitting — please submit again.');
    const snap = await snapshot.freeze(cx, c.id, row.revision, payload, me);
    await cx.q(
      "INSERT INTO uw_decisions (case_id, revision, snapshot_id, stage, action, rationale, terms, actor_id, actor_name, actor_role) VALUES (?,?,?,'analyst','submit',?,?,?,?,?)",
      [c.id, row.revision, snap.id, rationale, JSON.stringify(payload.case.terms), me.id, me.name, me.role]);
    await cx.q("UPDATE uw_cases SET status = 'submitted' WHERE id = ?", [c.id]);
    return snap;
  });
  await audit.log(req, 'uw.case.submit', 'uw_case', c.id, me.name + ' submitted ' + c.caseCode + ' r' + c.revision + ' to the checker',
    { snapshotId: out.id, sha256: out.sha256, rationale });
  for (const role of ['manager', 'director']) {
    await notify({ toRole: role, type: 'uw', message: c.caseCode + ' (' + c.legalName + ') was submitted for checking by ' + me.name + '.' });
  }
  return { ok: true, snapshot: out, case: await uwrepo.getCase(c.id) };
}));

async function currentSubmission(caseId, revision) {
  const rows = await q("SELECT * FROM uw_decisions WHERE case_id = ? AND revision = ? AND action = 'submit' ORDER BY id DESC LIMIT 1", [caseId, revision]);
  return rows.length ? uwrepo.mapDecision(rows[0]) : null;
}

/* Send back: a new revision opens; dispositions are carried forward. */
async function sendBack(cx, c, stage, user, rationale, snapshotId) {
  await cx.q(
    "INSERT INTO uw_decisions (case_id, revision, snapshot_id, stage, action, rationale, actor_id, actor_name, actor_role) VALUES (?,?,?,?,'send_back',?,?,?,?)",
    [c.id, c.revision, snapshotId, stage, rationale, user.id, user.name, user.role]);
  await cx.q("UPDATE uw_cases SET status = 'sent_back', revision = revision + 1 WHERE id = ?", [c.id]);
  await cx.q(
    `INSERT INTO uw_rule_dispositions (case_id, revision, rule_code, rule_version, kind, reviewer_id, reviewer_name, rationale, created_by_id, created_by)
     SELECT case_id, revision + 1, rule_code, rule_version, kind, reviewer_id, reviewer_name, rationale, created_by_id, created_by
       FROM uw_rule_dispositions WHERE case_id = ? AND revision = ?`, [c.id, c.revision]);
}

/* ---------------- checker ---------------- */
router.post('/cases/:id/check', H(async (req) => {
  const me = access.requireChecker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  if (c.status !== 'submitted') throw bad('The case is not waiting for a checker (status: ' + c.status.replace(/_/g, ' ') + ').');
  const action = oneOf(req.body.action, 'Action', ['recommend', 'send_back']);
  const rationale = reqStr(req.body.rationale, 'Checker comments', { max: 8000 });
  const sub = await currentSubmission(c.id, c.revision);
  if (!sub) throw bad('No submission found for this revision.');
  if (sub.actorId === me.id) throw Object.assign(new Error('You submitted this revision — another Manager or Director must check it.'), { status: 403 });

  await tx(async (cx) => {
    const [row] = await cx.q('SELECT status FROM uw_cases WHERE id = ? FOR UPDATE', [c.id]);
    if (row.status !== 'submitted') throw bad('The case changed state — reload.');
    if (action === 'send_back') return sendBack(cx, c, 'checker', me, rationale, sub.snapshotId);
    await cx.q(
      "INSERT INTO uw_decisions (case_id, revision, snapshot_id, stage, action, rationale, actor_id, actor_name, actor_role) VALUES (?,?,?,'checker','recommend',?,?,?,?)",
      [c.id, c.revision, sub.snapshotId, rationale, me.id, me.name, me.role]);
    await cx.q("UPDATE uw_cases SET status = 'recommended' WHERE id = ?", [c.id]);
  });
  await audit.log(req, 'uw.case.check.' + action, 'uw_case', c.id, me.name + (action === 'recommend' ? ' recommended ' : ' sent back ') + c.caseCode + ' r' + c.revision, { rationale, snapshotId: sub.snapshotId });
  if (action === 'recommend') await notify({ toRole: 'director', type: 'uw', message: c.caseCode + ' is ready for a sanction decision (checked by ' + me.name + ').' });
  if (sub.actorId) await notify({ toUserId: sub.actorId, type: 'uw', message: c.caseCode + ' was ' + (action === 'recommend' ? 'recommended to the sanction authority' : 'sent back') + ' by ' + me.name + ': ' + rationale.slice(0, 200) });
  return { ok: true, case: await uwrepo.getCase(c.id) };
}));

/* ---------------- sanction authority ---------------- */
function readModifiedTerms(b) {
  const p = money.paiseNumber(b && b.amount, 'INR', 'Sanctioned amount');
  if (p.error) throw bad(p.error);
  if (p.paise <= 0) throw bad('Sanctioned amount must be greater than zero.');
  const t = Number(b.tenorDays);
  if (!Number.isInteger(t) || t < 1 || t > 3650) throw bad('Sanctioned tenor must be a whole number of days between 1 and 3650.');
  const out = { amountPaise: p.paise, tenorDays: t };
  if (b.ratePct != null && String(b.ratePct).trim() !== '') {
    const d = money.parseDecimal(b.ratePct);
    if (!d || d.neg || d.scale > 4) throw bad('Rate must be a positive number with up to 4 decimals.');
    out.ratePct = String(b.ratePct).trim();
  }
  if (b.conditions) out.conditions = String(b.conditions).slice(0, 4000);
  return out;
}

router.post('/cases/:id/sanction', H(async (req) => {
  const me = access.requireSanction(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  if (c.status !== 'recommended') throw bad('The case is not waiting for a sanction decision (status: ' + c.status.replace(/_/g, ' ') + ').');
  const action = oneOf(req.body.action, 'Decision', ['approve', 'approve_modified', 'decline', 'send_back']);
  const rationale = reqStr(req.body.rationale, 'Decision rationale', { max: 8000 });
  const sub = await currentSubmission(c.id, c.revision);
  if (!sub) throw bad('No submission found for this revision.');
  if (sub.actorId === me.id) throw Object.assign(new Error('You submitted this revision — another Director must decide it.'), { status: 403 });
  const [chk] = await q("SELECT actor_id, actor_name FROM uw_decisions WHERE case_id = ? AND revision = ? AND stage = 'checker' AND action = 'recommend' ORDER BY id DESC LIMIT 1", [c.id, c.revision]);
  let sameAsChecker = false;
  if (chk && chk.actor_id === me.id) {
    // Separate checker and sanction authority — unless this desk has no other Director.
    const others = await access.activeDirectorsOtherThan([me.id, sub.actorId].filter(Boolean));
    if (others > 0) throw Object.assign(new Error('You checked this revision — another Director must take the sanction decision.'), { status: 403 });
    sameAsChecker = true;
  }
  const terms = action === 'approve_modified' ? readModifiedTerms(req.body.terms) : (action === 'approve' ? c.terms : null);

  await tx(async (cx) => {
    const [row] = await cx.q('SELECT status FROM uw_cases WHERE id = ? FOR UPDATE', [c.id]);
    if (row.status !== 'recommended') throw bad('The case changed state — reload.');
    if (action === 'send_back') return sendBack(cx, c, 'sanction', me, rationale, sub.snapshotId);
    const note = sameAsChecker ? '\n\n[Recorded by the same Director who checked this revision — no other active Director is available.]' : '';
    await cx.q(
      "INSERT INTO uw_decisions (case_id, revision, snapshot_id, stage, action, rationale, terms, actor_id, actor_name, actor_role) VALUES (?,?,?,'sanction',?,?,?,?,?,?)",
      [c.id, c.revision, sub.snapshotId, action, rationale + note, terms ? JSON.stringify(terms) : null, me.id, me.name, me.role]);
    await cx.q('UPDATE uw_cases SET status = ? WHERE id = ?', [action === 'approve' ? 'approved' : action === 'approve_modified' ? 'approved_modified' : 'declined', c.id]);
  });
  await audit.log(req, 'uw.case.sanction.' + action, 'uw_case', c.id, me.name + ' ' + action.replace('_', ' ') + 'd ' + c.caseCode + ' r' + c.revision,
    { rationale, terms, snapshotId: sub.snapshotId, sameAsChecker });
  if (sub.actorId) await notify({ toUserId: sub.actorId, type: 'uw', message: c.caseCode + ': sanction decision "' + action.replace('_', ' ') + '" by ' + me.name + '.' });
  return { ok: true, case: await uwrepo.getCase(c.id) };
}));

module.exports = router;
