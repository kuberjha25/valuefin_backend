'use strict';
/* Disbursement queue — no money leaves on one person's say-so.

   A Manager (or Director) raises a payout, a Director approves it, and only the
   Accounts team (or a Director) pays it out. The tranche is created at the moment
   it is value-dated — not when the request is raised, and not when it is
   approved — so nothing sits half-disbursed. Headroom and any drawdown stop are
   tested when the request is raised and again at payout, because the book can
   move in between. */
const express = require('express');
const { q, tx } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const audit = require('../audit');
const book = require('../book');
const ledger = require('../ledger');
const policy = require('../policy');
const { notify } = require('../notify');
const { H, bad, notFound, optStr, reqNum, reqDate, optNum, oneOf, reqId, flag } = require('../http');

const router = express.Router();
const MODES = ['none', '30d', '1m', '2m', 'custom'];
const STATUSES = ['pending', 'approved', 'disbursed', 'rejected'];

const SELECT = `SELECT r.*, b.name AS borrower_name, b.stop_drawdowns, sd.ref AS source_ref, dd.ref AS drawdown_ref,
                       dd.disbursed AS dd_net, dd.adv AS dd_adv, dd.ad AS dd_ad, dd.fee AS dd_fee, dd.gst_amt AS dd_gst
                  FROM disbursement_requests r
                  JOIN borrowers b ON b.id = r.borrower_id
                  LEFT JOIN drawdowns sd ON sd.id = r.source_drawdown_id
                  LEFT JOIN drawdowns dd ON dd.id = r.drawdown_id`;

function mapRequest(r, borrower) {
  // What the payout looks like: the real tranche once it exists, otherwise the engine's preview.
  let preview;
  if (r.drawdown_id && r.dd_net != null) {
    preview = { net: +r.dd_net, advance: +r.dd_adv, advanceDays: +r.dd_ad, fee: +r.dd_fee, gst: +r.dd_gst };
  } else {
    const d = calc.computeDrawdown({ ref: r.ref, poAmt: r.amount, bankDebit: r.value_date, mode: r.mode, cd: r.cd, feePct: r.fee_pct }, borrower);
    preview = { net: d.disbursed, advance: d.adv, advanceDays: d.ad, fee: d.fee, gst: d.gstAmt };
  }
  return {
    id: r.id, borrowerId: r.borrower_id, borrowerName: r.borrower_name, stopDrawdowns: !!r.stop_drawdowns,
    kind: r.kind, sourceDrawdownId: r.source_drawdown_id, sourceRef: r.source_ref || null,
    amount: +r.amount, valueDate: String(r.value_date).slice(0, 10), mode: r.mode, cd: r.cd, feePct: r.fee_pct == null ? null : +r.fee_pct,
    ref: r.ref, remarks: r.remarks, status: r.status,
    raisedBy: r.raised_by, raisedById: r.raised_by_id, raisedAt: String(r.raised_at).replace(' ', 'T'),
    decidedBy: r.decided_by, decidedAt: r.decided_at ? String(r.decided_at).replace(' ', 'T') : null, decisionNote: r.decision_note,
    paidBy: r.paid_by, paidAt: r.paid_at ? String(r.paid_at).replace(' ', 'T') : null,
    drawdownId: r.drawdown_id, drawdownRef: r.drawdown_ref || null, preview
  };
}

async function loadAll(where = '', args = []) {
  const [rows, store] = await Promise.all([
    q(SELECT + where + ' ORDER BY r.id DESC LIMIT 500', args), repo.loadEngineStore()
  ]);
  const byId = new Map(store.borrowers.map((b) => [b.id, b]));
  return rows.map((r) => mapRequest(r, byId.get(r.borrower_id)));
}
async function loadOne(id) {
  const rows = await q(SELECT + ' WHERE r.id = ?', [id]);
  if (!rows.length) throw notFound('Disbursement request not found.');
  const b = await repo.getBorrower(rows[0].borrower_id);
  return mapRequest(rows[0], b);
}

/* ---------------- list ---------------- */
router.get('/', H(async (req) => {
  auth.requireUser(req);
  const status = req.query.status ? oneOf(req.query.status, 'Status', STATUSES) : '';
  const all = await loadAll();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  all.forEach((r) => { counts[r.status]++; });
  return {
    requests: status ? all.filter((r) => r.status === status) : all,
    counts,
    awaitingPayout: calc.money(all.filter((r) => r.status === 'approved').reduce((s, r) => s + r.amount, 0))
  };
}));

/* ---------------- raise ---------------- */
router.post('/', H(async (req) => {
  const me = auth.requireWrite(req);
  const b = req.body || {};
  const borrowerId = reqId(b.borrowerId, 'Borrower');
  const kind = oneOf(b.kind, 'Kind', ['fresh', 'rotation'], 'fresh');
  const amount = reqNum(b.amount, 'Amount', { positive: true, max: 1e13 });
  const valueDate = reqDate(b.valueDate || calc.td(), 'Value date');
  const mode = oneOf(b.mode, 'Advance interest', MODES, 'none');
  const cd = optNum(b.cd, 'Advance days', null, { min: 1, max: 3650 });
  const feePct = b.feePct == null || b.feePct === '' ? null : reqNum(b.feePct, 'Processing fee', { min: 0, max: 100 });

  const store = await repo.loadEngineStore({ borrowerId });
  const borrower = store.borrowers[0];
  if (!borrower) throw notFound('Borrower not found.');
  await book.assertCanDraw(borrower);
  if (valueDate < borrower.sanctionDate) throw bad('The value date cannot precede the sanction date (' + borrower.sanctionDate + ').');

  let sourceId = null;
  if (kind === 'rotation') {
    sourceId = reqId(b.sourceDrawdownId, 'The tranche being rolled forward');
    const src = store.drawdowns.find((d) => d.id === sourceId);
    if (!src) throw notFound('That tranche does not belong to this borrower.');
    if (src.status === 'Repaid') throw bad('That tranche is already repaid — there is nothing to roll forward.');
    if (valueDate < src.bankDebit) throw bad('The value date cannot precede the original debit date.');
    const busy = await q("SELECT id FROM disbursement_requests WHERE source_drawdown_id = ? AND status IN ('pending','approved') LIMIT 1", [sourceId]);
    if (busy.length) throw bad('A rotation of this tranche is already in the queue.');
    const accrued = calc.money(calc.accruedFor(src, borrower, valueDate, store.payments));
    if (amount > src.outPrin + accrued + 0.5) {
      throw bad('A rotation cannot exceed the principal plus interest it settles (' + policy.inr(src.outPrin + accrued) + ').');
    }
    ledger.assertWithinLimit(store, borrowerId, amount, sourceId);
  } else {
    ledger.assertWithinLimit(store, borrowerId, amount);
  }

  const r = await q(
    `INSERT INTO disbursement_requests (borrower_id, kind, source_drawdown_id, amount, value_date, mode, cd, fee_pct, ref, remarks, raised_by_id, raised_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [borrowerId, kind, sourceId, amount, valueDate, mode, mode === 'custom' ? (cd || 30) : null, feePct,
      optStr(b.ref, 'Reference', { max: 80 }), optStr(b.remarks, 'Remarks', { max: 255 }), me.id, me.name]);
  await notify({ toRole: 'director', type: 'disbursement', borrowerId, customerName: borrower.name,
    message: me.name + ' requested a ' + (kind === 'rotation' ? 'rotation' : 'payout') + ' of ' + policy.inrShort(amount) + ' for ' + borrower.name + ' — awaiting your approval.' });
  await audit.log(req, 'disbursement.raised', 'disbursement', r.insertId,
    me.name + ' requested a ' + kind + ' payout of ' + policy.inrShort(amount) + ' for ' + borrower.name, { amount, valueDate, kind });
  return loadOne(r.insertId);
}));

/* ---------------- Director decides ---------------- */
router.post('/:id/decide', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Request');
  const r = await loadOne(id);
  if (r.status !== 'pending') throw bad('This request was already ' + r.status + '.');
  await book.assertChecker(me, r.raisedById, 'payout request');
  const approve = flag(req.body.approve);
  const note = optStr(req.body.note, 'Note', { max: 500 });
  if (!approve && !note) throw bad('A reason is required to reject a request.');

  await q(`UPDATE disbursement_requests SET status = ?, decided_by_id = ?, decided_by = ?, decided_at = NOW(3), decision_note = ? WHERE id = ?`,
    [approve ? 'approved' : 'rejected', me.id, me.name, note, id]);
  if (r.raisedById) {
    await notify({ toUserId: r.raisedById, type: 'decision', borrowerId: r.borrowerId, customerName: r.borrowerName,
      message: 'Your payout request of ' + policy.inrShort(r.amount) + ' for ' + r.borrowerName + ' was ' + (approve ? 'approved' : 'rejected') + (note ? ': ' + note : '.') });
  }
  if (approve) {
    await notify({ toRole: 'accounts', type: 'disbursement', borrowerId: r.borrowerId, customerName: r.borrowerName,
      message: 'A payout of ' + policy.inrShort(r.amount) + ' for ' + r.borrowerName + ' is approved and ready to be paid.' });
  }
  await audit.log(req, 'disbursement.' + (approve ? 'approved' : 'rejected'), 'disbursement', id,
    me.name + (approve ? ' approved' : ' rejected') + ' the payout of ' + policy.inrShort(r.amount) + ' for ' + r.borrowerName, { note });
  return loadOne(id);
}));

/* ---------------- Accounts pays out ---------------- */
router.post('/:id/disburse', H(async (req) => {
  const me = auth.requireRole(req, ['accounts', 'director'], 'Only the Accounts team (or a Director) can value-date a payout.');
  const id = reqId(req.params.id, 'Request');
  const r = await loadOne(id);
  if (r.status !== 'approved') throw bad(r.status === 'disbursed' ? 'This payout has already been made.' : 'Only an approved request can be paid out.');
  const valueDate = reqDate(req.body.valueDate || r.valueDate, 'Value date');

  // The book can move between approval and payout — test everything again.
  const store = await repo.loadEngineStore({ borrowerId: r.borrowerId });
  const borrower = store.borrowers[0];
  await book.assertCanDraw(borrower);
  if (valueDate < borrower.sanctionDate) throw bad('The value date cannot precede the sanction date (' + borrower.sanctionDate + ').');

  const input = { ref: r.ref, poAmt: r.amount, bankDebit: valueDate, mode: r.mode, cd: r.cd, feePct: r.feePct, rem: r.remarks };
  let newId, settlement = null;
  if (r.kind === 'rotation') {
    const old = store.drawdowns.find((d) => d.id === r.sourceDrawdownId);
    if (!old || old.status === 'Repaid') throw bad('The tranche this rotation replaces is no longer open.');
    if (valueDate < old.bankDebit) throw bad('The value date cannot precede the original debit date.');
    ledger.assertWithinLimit(store, r.borrowerId, r.amount, old.id);
    const accrued = calc.money(calc.accruedFor(old, borrower, valueDate, store.payments));
    if (r.amount > old.outPrin + accrued + 0.5) throw bad('The new principal now exceeds what the old tranche settles at.');
    settlement = calc.money(old.outPrin + accrued);
    input.ref = r.ref || (old.ref ? old.ref + '-R' : '');
    input.rem = r.remarks || ('Rotation of ' + (old.ref || 'drawdown #' + old.id));
    const nd = calc.computeDrawdown(input, borrower);
    newId = await tx(async (cx) => {
      const out = await ledger.rotate(cx, { old, borrower, newDrawdown: nd, date: valueDate, settlement,
        note: 'Rotation settlement (via disbursement request #' + id + ')', createdBy: me.name });
      await cx.q(`UPDATE disbursement_requests SET status = 'disbursed', paid_by = ?, paid_at = NOW(3), value_date = ?, drawdown_id = ? WHERE id = ?`,
        [me.name, valueDate, out.newId, id]);
      return out.newId;
    });
  } else {
    ledger.assertWithinLimit(store, r.borrowerId, r.amount);
    const nd = calc.computeDrawdown(input, borrower);
    newId = await tx(async (cx) => {
      const did = await ledger.insertDrawdown(cx.q, r.borrowerId, nd, me.name);
      await cx.q(`UPDATE disbursement_requests SET status = 'disbursed', paid_by = ?, paid_at = NOW(3), value_date = ?, drawdown_id = ? WHERE id = ?`,
        [me.name, valueDate, did, id]);
      return did;
    });
  }

  // The first money out turns the origination file into a disbursed facility.
  if (borrower.applicationId) {
    await q("UPDATE credit_applications SET stage = 'Disbursed' WHERE id = ? AND stage = 'Sanctioned'", [borrower.applicationId]);
  }
  if (r.raisedById) {
    await notify({ toUserId: r.raisedById, type: 'decision', borrowerId: r.borrowerId, customerName: r.borrowerName,
      message: 'The payout of ' + policy.inrShort(r.amount) + ' for ' + r.borrowerName + ' was paid out on ' + valueDate + '.' });
  }
  await audit.log(req, 'disbursement.disbursed', 'disbursement', id,
    me.name + ' paid out ' + policy.inrShort(r.amount) + ' to ' + r.borrowerName + ' (value date ' + valueDate + ')',
    { drawdownId: newId, settlement, valueDate });
  return loadOne(id);
}));

/* ---------------- withdraw ---------------- */
router.delete('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Request');
  const r = await loadOne(id);
  if (!['pending', 'rejected'].includes(r.status)) throw bad('Only a pending or rejected request can be withdrawn.');
  if (me.role !== 'director' && r.raisedById !== me.id) throw auth.fail(403, 'Only whoever raised it, or a Director, can withdraw a request.');
  await q('DELETE FROM disbursement_requests WHERE id = ?', [id]);
  await audit.log(req, 'disbursement.withdrawn', 'disbursement', id, me.name + ' withdrew the ' + policy.inrShort(r.amount) + ' request for ' + r.borrowerName);
  return { ok: true };
}));

module.exports = router;
