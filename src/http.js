'use strict';
/* Route plumbing: an async handler wrapper and the input validators every
   route uses, so a bad payload fails with a 400 and a sentence a user can act
   on rather than a 500 and a stack trace. */

const fail = (status, message) => Object.assign(new Error(message), { status });
const bad = (message) => fail(400, message);
const notFound = (message) => fail(404, message);

/* Wrap an async handler: resolve the value to JSON, funnel errors to next(). */
const H = (fn) => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((v) => { if (v !== undefined && !res.headersSent) res.json(v); })
    .catch(next);
};

/* ---- validators. Each throws a 400 with a readable message. ---- */
function reqStr(v, label, { max = 190, min = 1 } = {}) {
  const s = String(v == null ? '' : v).trim();
  if (s.length < min) throw bad(label + ' is required.');
  if (s.length > max) throw bad(label + ' must be at most ' + max + ' characters.');
  return s;
}
function optStr(v, label, { max = 190 } = {}) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > max) throw bad(label + ' must be at most ' + max + ' characters.');
  return s;
}
function reqNum(v, label, { min = null, max = null, positive = false } = {}) {
  if (v === '' || v == null) throw bad(label + ' is required.');
  const n = Number(v);
  if (!isFinite(n)) throw bad(label + ' must be a number.');
  if (positive && !(n > 0)) throw bad(label + ' must be greater than zero.');
  if (min != null && n < min) throw bad(label + ' cannot be below ' + min + '.');
  if (max != null && n > max) throw bad(label + ' cannot exceed ' + max + '.');
  return n;
}
function optNum(v, label, fallback, opts = {}) {
  if (v === '' || v == null) return fallback;
  return reqNum(v, label, opts);
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function reqDate(v, label) {
  const s = String(v == null ? '' : v).slice(0, 10);
  if (!ISO.test(s) || isNaN(new Date(s).getTime())) throw bad(label + ' must be a valid date (YYYY-MM-DD).');
  return s;
}
function optDate(v, label, fallback = null) {
  if (!v) return fallback;
  return reqDate(v, label);
}
function oneOf(v, label, allowed, fallback) {
  if ((v == null || v === '') && fallback !== undefined) return fallback;
  const s = String(v);
  if (!allowed.includes(s)) throw bad(label + ' must be one of: ' + allowed.join(', ') + '.');
  return s;
}
function reqId(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(label + ' is not a valid id.');
  return n;
}
function optId(v, label) {
  if (v == null || v === '') return null;
  return reqId(v, label);
}
const flag = (v) => v === true || v === 'true' || v === 1 || v === '1';

module.exports = { fail, bad, notFound, H, reqStr, optStr, reqNum, optNum, reqDate, optDate, oneOf, reqId, optId, flag };
