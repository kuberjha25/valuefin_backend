'use strict';
/* Sign-in, sign-out, session identity and self-service password change. */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { q } = require('../db/pool');
const { mapUser } = require('../repo');
const auth = require('../auth');
const audit = require('../audit');
const { H, bad, reqStr } = require('../http');

const router = express.Router();

/* Brute-force guard on the credential endpoint only. */
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait ten minutes and try again.' }
});

/* The sign-in screen lists accounts so nobody has to memorise an email —
   name, role and email only, never anything credential-shaped. */
router.get('/directory', H(async () => {
  const rows = await q('SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY FIELD(role,\'director\',\'manager\',\'analyst\'), name');
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role }));
}));

router.post('/login', loginLimiter, H(async (req, res) => {
  const email = reqStr(req.body.email, 'Email', { max: 190 }).toLowerCase();
  const password = String(req.body.password || '');
  if (!password) throw bad('Enter your password.');

  const rows = await q('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  const row = rows[0];
  // Same message and roughly the same work either way, so the response cannot
  // be used to enumerate which addresses exist.
  const ok = row && row.active && await auth.verifyPassword(password, row.password_hash);
  if (!ok) {
    await audit.log(req, 'login.failed', 'user', row ? row.id : null, 'Failed sign-in attempt for ' + email);
    throw Object.assign(new Error('Email or password is incorrect.'), { status: 401 });
  }

  const sid = await auth.createSession(row.id, req);
  await q('UPDATE users SET last_login_at = NOW(3) WHERE id = ?', [row.id]);
  res.cookie(auth.COOKIE, sid, auth.cookieOpts());

  const user = mapUser(row);
  req.user = user;
  await audit.log(req, 'login', 'user', user.id, user.name + ' signed in');
  return user;
}));

router.post('/logout', H(async (req, res) => {
  if (req.user) await audit.log(req, 'logout', 'user', req.user.id, req.user.name + ' signed out');
  await auth.destroySession(req.cookies[auth.COOKIE]);
  res.clearCookie(auth.COOKIE, { path: '/' });
  return { ok: true };
}));

router.get('/me', H(async (req) => (req.user ? req.user : null)));

router.post('/password', H(async (req) => {
  const u = auth.requireUser(req);
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  const rows = await q('SELECT password_hash FROM users WHERE id = ?', [u.id]);
  if (!rows.length || !await auth.verifyPassword(current, rows[0].password_hash)) throw bad('Your current password is incorrect.');
  const problem = auth.passwordProblem(next);
  if (problem) throw bad(problem);
  if (current === next) throw bad('The new password must be different from the current one.');

  await q('UPDATE users SET password_hash = ?, must_reset = 0 WHERE id = ?', [await auth.hashPassword(next), u.id]);
  // Keep the current session, drop every other one.
  await q('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [u.id, req.sessionId]);
  await audit.log(req, 'password.change', 'user', u.id, u.name + ' changed their password');
  return { ok: true };
}));

/* Active sessions for the signed-in user, so they can spot a stray login. */
router.get('/sessions', H(async (req) => {
  const u = auth.requireUser(req);
  const rows = await q(
    'SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC', [u.id]);
  return rows.map((r) => ({
    id: r.id, current: r.id === req.sessionId, ip: r.ip, userAgent: r.user_agent,
    createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at
  }));
}));

router.post('/sessions/revoke-others', H(async (req) => {
  const u = auth.requireUser(req);
  const r = await q('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [u.id, req.sessionId]);
  await audit.log(req, 'session.revoke', 'user', u.id, 'Revoked ' + r.affectedRows + ' other session(s)');
  return { ok: true, revoked: r.affectedRows };
}));

module.exports = router;
