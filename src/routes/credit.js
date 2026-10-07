'use strict';
/* Credit cases on a live facility: limit enhancements and annual renewals.

   A limit is not a number someone types over. Raising an increase re-runs the
   product's own sizing caps against today's figures, and a Director approves the
   case before the headroom appears. A facility does not roll on by default
   either: its conduct gates are computed off the book, and a failed gate can
   still be renewed — but only on a written deviation that stays on the case. */
const express = require('express');
const { q } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const audit = require('../audit');
const book = require('../book');
const monitor = require('../monitor');
const policy = require('../policy');
const { rebuildBorrower } = require('./borrowers');
const { notify } = require('../notify');
const { H, bad, notFound, optStr, reqStr, reqNum, optDate, reqDate, reqId, flag } = require('../http');

const enhancements = express.Router();
const renewals = express.Router();
const iso = (v) => (v == null ? null : String(v).replace(' ', 'T'));
const day = (v) => (v == null ? null : String(v).slice(0, 10));

/* ============================================================================
   Limit enhancement
   ========================================================================== */
function sizingFor(b, inputs) {
  if (!b.product) return { sizing: null, note: 'This is a legacy facility with no product on record, so there is nothing to re-size against.' };
  const x = inputs || {};
  const n = (v) => (v === '' || v == null ? 0 : +v || 0);
  const sized = policy.sizing(b.product, {
    rate: b.rate, tenorDays: calc.tenureDays(b),
    poTotal: n(x.poTotal), invTotal: n(x.invTotal), anchorListed: !!x.anchorListed,
    avgMonthlyRevenue: n(x.avgMonthlyRevenue), roundSize: n(x.roundSize), runwayMonths: n(x.runwayMonths),
    monthlyBurn: n(x.monthlyBurn), existingDebt: n(x.existingDebt), netCashSurplus: n(x.netCashSurplus)
  });
  return { sizing: sized };
}

function mapCase(r) {
  return {
    id: r.id, borrowerId: r.borrower_id, borrowerName: r.borrower_name, fromLimit: +r.from_limit, newLimit: +r.new_limit,
    increase: calc.money(+r.new_limit - +r.from_limit), effectiveDate: day(r.effective_date),
    sizing: repo.json(r.sizing, null), boardFlag: !!r.board_flag, notes: r.notes || '',
    status: r.status, raisedBy: r.raised_by, raisedById: r.raised_by_id, raisedAt: iso(r.raised_at),
    decidedBy: r.decided_by || null, decidedAt: iso(r.decided_at), decisionNote: r.decision_note || ''
  };
}

enhancements.get('/', H(async (req) => {
  auth.requireUser(req);
  const [rows, store] = await Promise.all([
    q(`SELECT e.*, b.name AS borrower_name FROM limit_enhancements e JOIN borrowers b ON b.id = e.borrower_id ORDER BY e.id DESC LIMIT 300`),
    repo.loadEngineStore()
  ]);
  const facilities = store.borrowers.filter((b) => b.status === 'active').map((b) => {
    const s = calc.borrowerSummary(store, b.id);
    return { borrowerId: b.id, name: b.name, product: b.product, limit: s.limit, baseLimit: s.baseLimit,
      outstanding: s.outstanding, utilPct: s.utilPct, available: s.available };
  }).sort((a, c) => c.utilPct - a.utilPct);
  return { cases: rows.map(mapCase), facilities };
}));

enhancements.post('/preview', H(async (req) => {
  auth.requireUser(req);
  const b = await repo.getBorrower(reqId(req.body.borrowerId, 'Borrower'));
  if (!b) throw notFound('Borrower not found.');
  return sizingFor(b, req.body.inputs);
}));

enhancements.post('/', H(async (req) => {
  const me = auth.requireWrite(req);
  const borrowerId = reqId(req.body.borrowerId, 'Borrower');
  const store = await repo.loadEngineStore({ borrowerId });
  const b = store.borrowers[0];
  if (!b) throw notFound('Borrower not found.');
  if (b.status === 'closed') throw bad('This facility is closed.');
  const newLimit = reqNum(req.body.newLimit, 'Proposed limit', { positive: true, max: 1e13 });
  const current = calc.currentLimit(store, borrowerId);
  if (newLimit <= current) throw bad('The proposed limit must be above the current ' + policy.inr(current) + '.');
  const effectiveDate = optDate(req.body.effectiveDate, 'Effective date', calc.td());
  const pending = await q("SELECT id FROM limit_enhancements WHERE borrower_id = ? AND status = 'pending' LIMIT 1", [borrowerId]);
  if (pending.length) throw bad('An increase for ' + b.name + ' is already with the Director.');

  const { sizing } = sizingFor(b, req.body.inputs);
  const boardFlag = newLimit > 2 * (+b.limit || 0);
  const r = await q(
    `INSERT INTO limit_enhancements (borrower_id, from_limit, new_limit, effective_date, sizing, board_flag, notes, raised_by_id, raised_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [borrowerId, current, newLimit, effectiveDate, sizing ? JSON.stringify(sizing) : null, boardFlag ? 1 : 0,
      optStr(req.body.notes, 'The case for it', { max: 4000 }), me.id, me.name]);
  await notify({ toRole: 'director', type: 'enhancement', borrowerId, customerName: b.name,
    message: me.name + ' proposed raising ' + b.name + "'s limit from " + policy.inrShort(current) + ' to ' + policy.inrShort(newLimit) + (boardFlag ? ' (Board level)' : '') + ' — awaiting your decision.' });
  await audit.log(req, 'enhancement.raised', 'enhancement', r.insertId,
    me.name + ' proposed a limit increase for ' + b.name + ': ' + policy.inrShort(current) + ' → ' + policy.inrShort(newLimit),
    { newLimit, current, sizing: sizing ? { eligible: sizing.eligible, binding: sizing.binding } : null, boardFlag });
  const [row] = await q('SELECT e.*, b.name AS borrower_name FROM limit_enhancements e JOIN borrowers b ON b.id = e.borrower_id WHERE e.id = ?', [r.insertId]);
  return mapCase(row);
}));

enhancements.post('/:id/decide', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Case');
  const [row] = await q('SELECT e.*, b.name AS borrower_name FROM limit_enhancements e JOIN borrowers b ON b.id = e.borrower_id WHERE e.id = ?', [id]);
  if (!row) throw notFound('Case not found.');
  const c = mapCase(row);
  if (c.status !== 'pending') throw bad('This case was already ' + c.status + '.');
  await book.assertChecker(me, c.raisedById, 'enhancement case');
  const approve = flag(req.body.approve);
  const note = optStr(req.body.note, 'Note', { max: 500 });
  if (!approve && !note) throw bad('A reason is required to reject a case.');

  let eventId = null;
  if (approve) {
    const store = await repo.loadEngineStore({ borrowerId: c.borrowerId });
    const current = calc.currentLimit(store, c.borrowerId);
    const incr = calc.money(c.newLimit - current);
    if (incr <= 0) throw bad('The limit is already at or above ' + policy.inr(c.newLimit) + ' — there is nothing left to approve.');
    const ev = await q('INSERT INTO limit_history (borrower_id, event_date, incr_amt, note, created_by) VALUES (?,?,?,?,?)',
      [c.borrowerId, c.effectiveDate, incr, 'Enhancement case #' + id + (note ? ' — ' + note : ''), me.name]);
    eventId = ev.insertId;
  }
  await q(`UPDATE limit_enhancements SET status = ?, decided_by = ?, decided_at = NOW(3), decision_note = ?, limit_event_id = ? WHERE id = ?`,
    [approve ? 'approved' : 'rejected', me.name, note, eventId, id]);
  if (c.raisedById) {
    await notify({ toUserId: c.raisedById, type: 'decision', borrowerId: c.borrowerId, customerName: c.borrowerName,
      message: 'The limit increase for ' + c.borrowerName + ' was ' + (approve ? 'approved — the headroom is live' : 'rejected') + (note ? ': ' + note : '.') });
  }
  await audit.log(req, 'enhancement.' + (approve ? 'approved' : 'rejected'), 'enhancement', id,
    me.name + (approve ? ' approved' : ' rejected') + ' the limit increase for ' + c.borrowerName, { note, limitEventId: eventId });
  const [after] = await q('SELECT e.*, b.name AS borrower_name FROM limit_enhancements e JOIN borrowers b ON b.id = e.borrower_id WHERE e.id = ?', [id]);
  return mapCase(after);
}));

/* ============================================================================
   Renewals
   ========================================================================== */
function mapRenewal(r) {
  return {
    id: r.id, borrowerId: r.borrower_id, borrowerName: r.borrower_name, newExpiry: day(r.new_expiry),
    currentRate: +r.current_rate, newRate: +r.new_rate, cutBps: +r.cut_bps, gates: repo.json(r.gates, []) || [],
    behaviour: r.behaviour || '', deviationNote: r.deviation_note || '', status: r.status,
    raisedBy: r.raised_by, raisedById: r.raised_by_id, raisedAt: iso(r.raised_at),
    decidedBy: r.decided_by || null, decidedAt: iso(r.decided_at), decisionNote: r.decision_note || ''
  };
}
const RENEWAL_SELECT = 'SELECT c.*, b.name AS borrower_name FROM renewal_cases c JOIN borrowers b ON b.id = c.borrower_id';

renewals.get('/', H(async (req) => {
  auth.requireUser(req);
  const [rows, store, high] = await Promise.all([
    q(RENEWAL_SELECT + ' ORDER BY c.id DESC LIMIT 300'), repo.loadEngineStore(), monitor.highAlertBorrowers()
  ]);
  return { cases: rows.map(mapRenewal), due: monitor.dueForReview(store, high) };
}));

renewals.post('/', H(async (req) => {
  const me = auth.requireWrite(req);
  const borrowerId = reqId(req.body.borrowerId, 'Borrower');
  const store = await repo.loadEngineStore({ borrowerId });
  const b = store.borrowers[0];
  if (!b) throw notFound('Borrower not found.');
  if (b.status === 'closed') throw bad('This facility is closed.');
  const pending = await q("SELECT id FROM renewal_cases WHERE borrower_id = ? AND status = 'pending' LIMIT 1", [borrowerId]);
  if (pending.length) throw bad('A renewal for ' + b.name + ' is already with the Director.');

  const newExpiry = reqDate(req.body.newExpiry, 'New expiry');
  if (newExpiry <= calc.td()) throw bad('The new expiry must be in the future.');
  const cutBps = Math.round(reqNum(req.body.cutBps == null || req.body.cutBps === '' ? 0 : req.body.cutBps, 'Rate cut', { min: 0, max: 100 }));
  const floor = b.product ? policy.PRODUCTS[b.product].floor : 0;
  const newRate = Math.max(floor, +(b.rate - cutBps / 100).toFixed(2));
  const behaviour = reqStr(req.body.behaviour, 'How the account has behaved', { max: 4000 });

  const high = await monitor.highAlertBorrowers();
  const gates = monitor.renewalGates(b, store, high);
  const failed = gates.filter((g) => !g.pass);
  const deviationNote = optStr(req.body.deviationNote, 'Deviation note', { max: 4000 });
  if (failed.length && !deviationNote) throw bad(failed.length + ' conduct gate(s) failed — a written deviation note is mandatory.');

  const r = await q(
    `INSERT INTO renewal_cases (borrower_id, new_expiry, current_rate, new_rate, cut_bps, gates, behaviour, deviation_note, raised_by_id, raised_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [borrowerId, newExpiry, b.rate, newRate, Math.round((b.rate - newRate) * 100), JSON.stringify(gates), behaviour, deviationNote, me.id, me.name]);
  await notify({ toRole: 'director', type: 'renewal', borrowerId, customerName: b.name,
    message: me.name + ' proposed renewing ' + b.name + (failed.length ? ' on a deviation (' + failed.length + ' gate(s) failed)' : '') + ' — awaiting your decision.' });
  await audit.log(req, 'renewal.raised', 'renewal', r.insertId, me.name + ' proposed renewing ' + b.name + ' to ' + newExpiry,
    { newRate, cutBps, failedGates: failed.map((g) => g.key) });
  const [row] = await q(RENEWAL_SELECT + ' WHERE c.id = ?', [r.insertId]);
  return mapRenewal(row);
}));

renewals.post('/:id/decide', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Case');
  const [row] = await q(RENEWAL_SELECT + ' WHERE c.id = ?', [id]);
  if (!row) throw notFound('Case not found.');
  const c = mapRenewal(row);
  if (c.status !== 'pending') throw bad('This case was already ' + c.status + '.');
  await book.assertChecker(me, c.raisedById, 'renewal case');
  const approve = flag(req.body.approve);
  const note = optStr(req.body.note, 'Note', { max: 500 });
  if (!approve && !note) throw bad('A reason is required to reject a renewal.');

  if (approve) {
    // A renewal is a zero-amount limit event dated a year before the new expiry, so the
    // review clock (latest event + 1 year) lands exactly on it.
    const d = new Date(c.newExpiry); d.setFullYear(d.getFullYear() - 1);
    await q('INSERT INTO limit_history (borrower_id, event_date, incr_amt, note, created_by) VALUES (?,?,0,?,?)',
      [c.borrowerId, d.toISOString().slice(0, 10), 'Renewal case #' + id + ' — valid to ' + c.newExpiry, me.name]);
    if (c.newRate !== c.currentRate) {
      await q('UPDATE borrowers SET `rate` = ? WHERE id = ?', [c.newRate, c.borrowerId]);
      await rebuildBorrower(c.borrowerId);     // re-price every open tranche from its own history
    }
  }
  await q(`UPDATE renewal_cases SET status = ?, decided_by = ?, decided_at = NOW(3), decision_note = ? WHERE id = ?`,
    [approve ? 'approved' : 'rejected', me.name, note, id]);
  if (c.raisedById) {
    await notify({ toUserId: c.raisedById, type: 'decision', borrowerId: c.borrowerId, customerName: c.borrowerName,
      message: 'The renewal of ' + c.borrowerName + ' was ' + (approve ? 'approved — valid to ' + c.newExpiry : 'rejected') + (note ? ': ' + note : '.') });
  }
  await audit.log(req, 'renewal.' + (approve ? 'approved' : 'rejected'), 'renewal', id,
    me.name + (approve ? ' renewed ' : ' rejected the renewal of ') + c.borrowerName, { note, newRate: c.newRate });
  const [after] = await q(RENEWAL_SELECT + ' WHERE c.id = ?', [id]);
  return mapRenewal(after);
}));

module.exports = { enhancements, renewals };
