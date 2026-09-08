'use strict';
/* Team administration — Director only. Create staff, change a role, suspend an
   account, reset a password. Deactivating or resetting also kills that user's
   live sessions immediately. */
const express = require('express');
const { q } = require('../db/pool');
const { mapUser } = require('../repo');
const auth = require('../auth');
const audit = require('../audit');
const { H, bad, notFound, reqStr, reqId, oneOf, flag } = require('../http');

const router = express.Router();
const ROLES = ['director', 'manager', 'analyst'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.get('/', H(async (req) => {
  auth.requireUser(req);
  const rows = await q(`
    SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > NOW(3)) AS live
      FROM users u ORDER BY FIELD(u.role,'director','manager','analyst'), u.name`);
  return rows.map((r) => Object.assign(mapUser(r), { liveSessions: +r.live }));
}));

router.post('/', H(async (req) => {
  const me = auth.requireDirector(req);
  const name = reqStr(req.body.name, 'Name', { max: 120 });
  const email = reqStr(req.body.email, 'Email').toLowerCase();
  if (!EMAIL.test(email)) throw bad('Enter a valid email address.');
  const role = oneOf(req.body.role, 'Role', ROLES);
  const password = String(req.body.password || '');
  const problem = auth.passwordProblem(password);
  if (problem) throw bad(problem);

  const dupe = await q('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (dupe.length) throw bad('An account with that email already exists.');

  const r = await q(
    'INSERT INTO users (name, email, role, password_hash, must_reset) VALUES (?, ?, ?, ?, 1)',
    [name, email, role, await auth.hashPassword(password)]);
  await audit.log(req, 'user.create', 'user', r.insertId, me.name + ' created ' + role + ' account ' + email);
  const rows = await q('SELECT * FROM users WHERE id = ?', [r.insertId]);
  return mapUser(rows[0]);
}));

router.put('/:id', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'User');
  const rows = await q('SELECT * FROM users WHERE id = ?', [id]);
  if (!rows.length) throw notFound('User not found.');
  const target = mapUser(rows[0]);

  const name = req.body.name != null ? reqStr(req.body.name, 'Name', { max: 120 }) : target.name;
  const role = req.body.role != null ? oneOf(req.body.role, 'Role', ROLES) : target.role;
  const active = req.body.active != null ? flag(req.body.active) : target.active;

  // The book must never be left without a Director who can sign in.
  if (target.role === 'director' && (role !== 'director' || !active)) {
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM users WHERE role = 'director' AND active = 1 AND id <> ?", [id]);
    if (n === 0) throw bad('This is the last active Director — promote someone else first.');
  }
  if (target.id === me.id && !active) throw bad('You cannot deactivate your own account.');

  await q('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?', [name, role, active ? 1 : 0, id]);
  if (!active) await auth.destroyUserSessions(id);
  await audit.log(req, 'user.update', 'user', id, me.name + ' updated ' + target.email,
    { from: { name: target.name, role: target.role, active: target.active }, to: { name, role, active } });

  const after = await q('SELECT * FROM users WHERE id = ?', [id]);
  return mapUser(after[0]);
}));

router.post('/:id/password', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'User');
  const password = String(req.body.password || '');
  const problem = auth.passwordProblem(password);
  if (problem) throw bad(problem);
  const rows = await q('SELECT * FROM users WHERE id = ?', [id]);
  if (!rows.length) throw notFound('User not found.');

  await q('UPDATE users SET password_hash = ?, must_reset = 1 WHERE id = ?', [await auth.hashPassword(password), id]);
  await auth.destroyUserSessions(id);
  await audit.log(req, 'user.password.reset', 'user', id, me.name + ' reset the password for ' + rows[0].email);
  return { ok: true };
}));

router.delete('/:id', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'User');
  if (id === me.id) throw bad('You cannot delete your own account.');
  const rows = await q('SELECT * FROM users WHERE id = ?', [id]);
  if (!rows.length) throw notFound('User not found.');
  if (rows[0].role === 'director') {
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM users WHERE role = 'director' AND active = 1 AND id <> ?", [id]);
    if (n === 0) throw bad('This is the last active Director — promote someone else first.');
  }
  await q('DELETE FROM users WHERE id = ?', [id]);
  await audit.log(req, 'user.delete', 'user', id, me.name + ' deleted account ' + rows[0].email);
  return { ok: true };
}));

module.exports = router;
