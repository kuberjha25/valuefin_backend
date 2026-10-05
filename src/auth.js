'use strict';
/* Authentication: bcrypt password hashing + server-side sessions held in MySQL,
   so sessions survive a restart and can be revoked centrally. The cookie only
   ever carries an opaque UUID. */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { q } = require('./db/pool');
const { mapUser } = require('./repo');

const COOKIE = 'vf_sid';
const cookieOpts = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.env === 'production',
  maxAge: config.sessionTtlHours * 3600 * 1000,
  path: '/'
});

const hashPassword = (plain) => bcrypt.hash(String(plain), config.bcryptRounds);
const verifyPassword = (plain, hash) => bcrypt.compare(String(plain), String(hash || ''));

/* Enforced on every new/changed password. */
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(s)) return 'Password must contain a letter.';
  if (!/[0-9]/.test(s)) return 'Password must contain a number.';
  return null;
}

async function createSession(userId, req) {
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  await q(
    'INSERT INTO sessions (id, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 255), sqlDate(expires)]
  );
  return id;
}

async function destroySession(id) { if (id) await q('DELETE FROM sessions WHERE id = ?', [id]); }
async function destroyUserSessions(userId) { await q('DELETE FROM sessions WHERE user_id = ?', [userId]); }
async function purgeExpiredSessions() { await q('DELETE FROM sessions WHERE expires_at < NOW(3)'); }

/* Resolves req.user (or null) from the session cookie, sliding the expiry
   forward on each authenticated request. */
async function attachUser(req, res, next) {
  try {
    req.user = null;
    const sid = req.cookies ? req.cookies[COOKIE] : null;
    if (!sid) return next();
    const rows = await q(
      `SELECT u.*, s.id AS sid FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > NOW(3) AND u.active = 1`, [sid]
    );
    if (!rows.length) { res.clearCookie(COOKIE, { path: '/' }); return next(); }
    req.user = mapUser(rows[0]);
    req.sessionId = sid;
    const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
    await q('UPDATE sessions SET last_seen_at = NOW(3), expires_at = ? WHERE id = ?', [sqlDate(expires), sid]);
    next();
  } catch (e) { next(e); }
}

/* ---- guards. Each throws an HTTP-shaped error the error handler understands. ---- */
const fail = (status, message) => Object.assign(new Error(message), { status });

function requireUser(req) {
  if (!req.user) throw fail(401, 'Your session has expired — please sign in again.');
  return req.user;
}
function requireWrite(req) {
  const u = requireUser(req);
  if (u.role === 'analyst') throw fail(403, 'The Analyst role is read-only for this action.');
  return u;
}
function requireDirector(req) {
  const u = requireUser(req);
  if (u.role !== 'director') throw fail(403, 'Only the Director can perform this action.');
  return u;
}

function clientIp(req) {
  return String(req.ip || '').slice(0, 64);   // honours `trust proxy`, not a client-supplied header
}
const sqlDate = (d) => new Date(d).toISOString().slice(0, 23).replace('T', ' ');

module.exports = {
  COOKIE, cookieOpts, hashPassword, verifyPassword, passwordProblem,
  createSession, destroySession, destroyUserSessions, purgeExpiredSessions,
  attachUser, requireUser, requireWrite, requireDirector, clientIp, fail, sqlDate
};
