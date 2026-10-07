'use strict';
/* Monitoring — early-warning alerts, site visits, borrower MIS and the Director's
   drawdown stop. The rules themselves live in monitor.js; this file is the
   handling of what staff do about them. */
const express = require('express');
const { q } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const audit = require('../audit');
const monitor = require('../monitor');
const book = require('../book');
const { notify } = require('../notify');
const { H, bad, notFound, optStr, reqStr, reqNum, reqDate, reqId, oneOf, flag } = require('../http');

const ews = express.Router();
const visits = express.Router();
const mis = express.Router();

const iso = (v) => (v == null ? null : String(v).replace(' ', 'T'));
const day = (v) => (v == null ? null : String(v).slice(0, 10));

/* ============================================================================
   Early warning
   ========================================================================== */
const ALERT_SELECT = 'SELECT a.*, b.name AS borrower_name FROM ews_alerts a JOIN borrowers b ON b.id = a.borrower_id';

function mapAlert(r) {
  return {
    id: r.id, borrowerId: r.borrower_id, borrowerName: r.borrower_name, ruleKey: r.rule_key || null, auto: !!r.auto,
    severity: r.severity, message: r.message, status: r.status, raisedBy: r.raised_by, createdAt: iso(r.created_at),
    acknowledgedBy: r.acknowledged_by || null, acknowledgedAt: iso(r.acknowledged_at),
    resolvedBy: r.resolved_by || null, resolvedAt: iso(r.resolved_at), resolution: r.resolution || '',
    requestedDocs: repo.json(r.requested_docs, []) || []
  };
}

/* The rules run on demand, and at most every ten minutes when someone opens the screen. */
let lastScan = 0;
async function scanIfStale() {
  if (Date.now() - lastScan < 10 * 60 * 1000) return;
  lastScan = Date.now();
  await monitor.scan();
}

ews.get('/', H(async (req) => {
  auth.requireUser(req);
  await scanIfStale();
  const status = req.query.status ? oneOf(req.query.status, 'Status', ['open', 'acknowledged', 'resolved']) : '';
  const [rows, stopped] = await Promise.all([
    q(ALERT_SELECT + ' ORDER BY FIELD(a.severity,\'high\',\'medium\',\'low\'), a.id DESC LIMIT 500'),
    q('SELECT id, name FROM borrowers WHERE stop_drawdowns = 1 ORDER BY name')
  ]);
  const all = rows.map(mapAlert);
  return {
    alerts: status ? all.filter((a) => a.status === status) : all,
    counts: {
      open: all.filter((a) => a.status === 'open').length,
      high: all.filter((a) => a.status === 'open' && a.severity === 'high').length,
      acknowledged: all.filter((a) => a.status === 'acknowledged').length,
      resolved: all.filter((a) => a.status === 'resolved').length
    },
    stoppedBorrowers: stopped.map((b) => ({ id: b.id, name: b.name }))
  };
}));

ews.post('/scan', H(async (req) => {
  const me = auth.requireUser(req);
  lastScan = Date.now();
  const r = await monitor.scan();
  await audit.log(req, 'ews.scan', 'ews', null, me.name + ' re-ran the early-warning rules — ' + r.raised + ' new alert(s)', r);
  return r;
}));

ews.post('/', H(async (req) => {
  const me = auth.requireWrite(req);
  const borrowerId = reqId(req.body.borrowerId, 'Borrower');
  const b = await repo.getBorrower(borrowerId);
  if (!b) throw notFound('Borrower not found.');
  const severity = oneOf(req.body.severity, 'Severity', ['low', 'medium', 'high'], 'medium');
  const message = reqStr(req.body.message, 'What happened', { max: 1000 });
  const docs = (Array.isArray(req.body.requestedDocs) ? req.body.requestedDocs : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
    .map((label) => ({ label: label.slice(0, 190), by: me.name, at: new Date().toISOString() }));
  const r = await q(`INSERT INTO ews_alerts (borrower_id, rule_key, auto, severity, message, raised_by, requested_docs) VALUES (?, NULL, 0, ?, ?, ?, ?)`,
    [borrowerId, severity, message, me.name, JSON.stringify(docs)]);
  await audit.log(req, 'ews.raised', 'ews', r.insertId, me.name + ' logged a ' + severity + ' event for ' + b.name + ': ' + message.slice(0, 120));
  const [row] = await q(ALERT_SELECT + ' WHERE a.id = ?', [r.insertId]);
  return mapAlert(row);
}));

async function loadAlert(id) {
  const [row] = await q(ALERT_SELECT + ' WHERE a.id = ?', [id]);
  if (!row) throw notFound('Alert not found.');
  return row;
}

ews.post('/:id/acknowledge', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Alert');
  const a = await loadAlert(id);
  if (a.status !== 'open') throw bad('This alert is already ' + a.status + '.');
  await q("UPDATE ews_alerts SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = NOW(3) WHERE id = ?", [me.name, id]);
  await audit.log(req, 'ews.acknowledged', 'ews', id, me.name + ' picked up the alert on ' + a.borrower_name);
  return mapAlert(await loadAlert(id));
}));

ews.post('/:id/resolve', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Alert');
  const a = await loadAlert(id);
  if (a.status === 'resolved') throw bad('This alert is already resolved.');
  const resolution = reqStr(req.body.resolution, 'What was actually done about it', { max: 1000 });
  await q("UPDATE ews_alerts SET status = 'resolved', resolved_by = ?, resolved_at = NOW(3), resolution = ? WHERE id = ?", [me.name, resolution, id]);
  await audit.log(req, 'ews.resolved', 'ews', id, me.name + ' resolved the alert on ' + a.borrower_name + ': ' + resolution.slice(0, 160));
  return mapAlert(await loadAlert(id));
}));

ews.post('/:id/request-documents', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Alert');
  const a = await loadAlert(id);
  const asked = (Array.isArray(req.body.documents) ? req.body.documents : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
  if (!asked.length) throw bad('Name at least one document to ask for.');
  const have = repo.json(a.requested_docs, []) || [];
  asked.forEach((label) => have.push({ label: label.slice(0, 190), by: me.name, at: new Date().toISOString() }));
  await q('UPDATE ews_alerts SET requested_docs = ? WHERE id = ?', [JSON.stringify(have), id]);
  await notify({ toRole: 'manager', type: 'ews', borrowerId: a.borrower_id, customerName: a.borrower_name,
    message: me.name + ' asked ' + a.borrower_name + ' for: ' + asked.join('; ') + '.' });
  await audit.log(req, 'ews.documents', 'ews', id, me.name + ' asked ' + a.borrower_name + ' for ' + asked.length + ' document(s)', { asked });
  return mapAlert(await loadAlert(id));
}));

/* The Director's hard stop: no fresh money, no rotation, until a Director lifts it. */
const drawdownStop = H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Borrower');
  const b = await repo.getBorrower(id);
  if (!b) throw notFound('Borrower not found.');
  const stop = flag(req.body.stop);
  const reason = optStr(req.body.reason, 'Reason', { max: 500 });
  if (stop && !reason) throw bad('A reason is required to stop drawdowns.');
  await q('UPDATE borrowers SET stop_drawdowns = ?, stop_reason = ?, stop_by = ?, stop_at = NOW(3) WHERE id = ?',
    [stop ? 1 : 0, stop ? reason : '', me.name, id]);
  await notify({ toRole: 'manager', type: 'ews', borrowerId: id, customerName: b.name,
    message: me.name + (stop ? ' stopped all drawdowns to ' + b.name + ': ' + reason : ' lifted the drawdown stop on ' + b.name + '.') });
  await audit.log(req, stop ? 'borrower.drawdown-stop' : 'borrower.drawdown-lift', 'borrower', id,
    me.name + (stop ? ' stopped drawdowns to ' : ' lifted the drawdown stop on ') + b.name + (stop ? ': ' + reason : ''), { stop, reason });
  return { ok: true, stopDrawdowns: stop };
});

/* ============================================================================
   Site visits
   ========================================================================== */
visits.get('/', H(async (req) => {
  auth.requireUser(req);
  const [rows, store, last] = await Promise.all([
    q(`SELECT v.*, b.name AS borrower_name FROM site_visits v JOIN borrowers b ON b.id = v.borrower_id ORDER BY v.visit_date DESC, v.id DESC LIMIT 500`),
    repo.loadEngineStore(), monitor.lastVisits()
  ]);
  return {
    visits: rows.map((v) => ({ id: v.id, borrowerId: v.borrower_id, borrowerName: v.borrower_name, date: day(v.visit_date),
      visitedBy: v.visited_by, notes: v.notes || '', createdBy: v.created_by })),
    cadence: monitor.cadenceFor(store, last)
  };
}));

visits.post('/', H(async (req) => {
  const me = auth.requireWrite(req);
  const borrowerId = reqId(req.body.borrowerId, 'Borrower');
  const b = await repo.getBorrower(borrowerId);
  if (!b) throw notFound('Borrower not found.');
  const date = reqDate(req.body.date || calc.td(), 'Visit date');
  if (date > calc.td()) throw bad('A visit cannot be dated in the future.');
  const notes = reqStr(req.body.notes, 'What you saw', { max: 4000 });
  const visitedBy = optStr(req.body.visitedBy, 'Visited by', { max: 120 }) || me.name;

  const r = await q('INSERT INTO site_visits (borrower_id, visit_date, visited_by, notes, created_by) VALUES (?,?,?,?,?)',
    [borrowerId, date, visitedBy, notes, me.name]);
  // Logging the visit is precisely what the cadence alert asked for.
  await q(`UPDATE ews_alerts SET status = 'resolved', resolved_by = ?, resolved_at = NOW(3), resolution = ?
            WHERE borrower_id = ? AND rule_key = 'visit' AND status <> 'resolved'`,
  [me.name, 'Site visit logged for ' + date + ' by ' + visitedBy + '.', borrowerId]);
  await audit.log(req, 'visit.logged', 'borrower', borrowerId, me.name + ' logged a site visit to ' + b.name + ' on ' + date, { visitId: r.insertId, visitedBy });
  return { id: r.insertId, borrowerId, date, visitedBy, notes };
}));

/* ============================================================================
   Borrower MIS — revenue, burn and closing cash, one row per borrower per month
   ========================================================================== */
const mapMis = (r, name) => ({
  id: r.id, borrowerId: r.borrower_id, borrowerName: name || r.borrower_name, month: r.month,
  revenue: +r.revenue, burn: +r.burn, closingCash: +r.closing_cash, runwayMonths: monitor.runwayOf(r),
  note: r.note || '', createdBy: r.created_by
});

mis.get('/', H(async (req) => {
  auth.requireUser(req);
  const where = req.query.borrowerId ? ' WHERE m.borrower_id = ?' : '';
  const rows = await q(`SELECT m.*, b.name AS borrower_name FROM borrower_mis m JOIN borrowers b ON b.id = m.borrower_id${where}
                         ORDER BY m.month DESC, b.name LIMIT 1000`, req.query.borrowerId ? [reqId(req.query.borrowerId, 'Borrower')] : []);
  return rows.map((r) => mapMis(r));
}));

mis.post('/', H(async (req) => {
  const me = auth.requireWrite(req);
  const borrowerId = reqId(req.body.borrowerId, 'Borrower');
  const b = await repo.getBorrower(borrowerId);
  if (!b) throw notFound('Borrower not found.');
  const month = String(req.body.month || '').slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('Month must look like 2026-08.');
  if (month > calc.td().slice(0, 7)) throw bad('That month has not happened yet.');
  const revenue = reqNum(req.body.revenue, 'Revenue', { min: 0, max: 1e13 });
  const burn = reqNum(req.body.burn, 'Burn', { min: 0, max: 1e13 });
  const closingCash = reqNum(req.body.closingCash, 'Closing cash', { min: 0, max: 1e14 });
  const note = optStr(req.body.note, 'Note', { max: 255 });

  // Re-filing a month corrects it rather than adding a second row.
  await q(`INSERT INTO borrower_mis (borrower_id, month, revenue, burn, closing_cash, note, created_by) VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE revenue = VALUES(revenue), burn = VALUES(burn), closing_cash = VALUES(closing_cash),
                                   note = VALUES(note), created_by = VALUES(created_by)`,
  [borrowerId, month, revenue, burn, closingCash, note, me.name]);
  // Filing the month that was missing is what the missing-MIS alert asked for.
  if (month === book.previousMonth()) {
    await q(`UPDATE ews_alerts SET status = 'resolved', resolved_by = ?, resolved_at = NOW(3), resolution = ?
              WHERE borrower_id = ? AND rule_key = 'mis_missing' AND status <> 'resolved'`,
    [me.name, 'MIS for ' + month + ' filed by ' + me.name + '.', borrowerId]);
  }
  await monitor.scan({ borrowerId });     // a thin runway or a revenue drop raises its alert straight away
  await audit.log(req, 'mis.filed', 'borrower', borrowerId, me.name + ' filed the MIS for ' + b.name + ' — ' + month,
    { revenue, burn, closingCash });
  const [row] = await q('SELECT * FROM borrower_mis WHERE borrower_id = ? AND month = ?', [borrowerId, month]);
  return mapMis(row, b.name);
}));

module.exports = { ews, visits, mis, drawdownStop };
