'use strict';
/* Drawdowns — each disbursal against a facility, plus rotation (rolling an
   outstanding drawdown into a fresh one at maturity). */
const express = require('express');
const { q, tx } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const book = require('../book');
const audit = require('../audit');
const { H, bad, notFound, reqStr, optStr, reqNum, optNum, reqDate, optDate, oneOf, reqId, optId, flag } = require('../http');

const router = express.Router();
const MODES = ['none', '30d', '1m', '2m', 'custom'];

/* ---------------- list (whole book) ---------------- */
router.get('/', H(async (req) => {
  auth.requireUser(req);
  const borrowerId = optId(req.query.borrowerId, 'Borrower');
  const store = await repo.loadEngineStore(borrowerId ? { borrowerId } : {});
  const byId = new Map(store.borrowers.map((b) => [b.id, b]));

  let rows = store.drawdowns.map((d) => {
    const b = byId.get(d.borrowerId) || {};
    return Object.assign(calc.decorateDrawdown(d, b, store.payments), { borrowerName: b.name, borrowerSlug: b.slug });
  });
  if (req.query.status) rows = rows.filter((d) => d.status === req.query.status);
  if (flag(req.query.overdue)) rows = rows.filter((d) => d.overdueDays > 0);
  return rows.sort((a, c) => (a.bankDebit === c.bankDebit ? c.id - a.id : (a.bankDebit < c.bankDebit ? 1 : -1)));
}));

/* What closing a drawdown on a chosen date would cost, with the working. */
router.get('/:id/settlement', H(async (req) => {
  auth.requireUser(req);
  const id = reqId(req.params.id, 'Drawdown');
  const d = await repo.getDrawdown(id);
  if (!d) throw notFound('Drawdown not found.');
  if (d.status === 'Repaid') throw bad('This drawdown is already repaid — there is nothing to settle.');
  const store = await repo.loadEngineStore({ borrowerId: d.borrowerId });
  const b = store.borrowers[0];
  const date = optDate(req.query.date, 'Settlement date', calc.td());
  if (date < d.bankDebit) throw bad('The settlement date cannot precede the debit date (' + d.bankDebit + ').');
  const mode = oneOf(req.query.mode, 'Advance interest', ['keep', 'refund'], 'keep');
  const payments = store.payments.filter((p) => p.drawdownId === id);
  return {
    settlement: calc.settlement(d, b, payments, date, mode),
    drawdown: Object.assign(calc.decorateDrawdown(d, b, store.payments, date), { borrowerName: b.name }),
    borrower: b,
    payments: payments.sort((a, c) => (a.date === c.date ? a.id - c.id : (a.date < c.date ? -1 : 1)))
  };
}));

router.get('/:id', H(async (req) => {
  auth.requireUser(req);
  const id = reqId(req.params.id, 'Drawdown');
  const d = await repo.getDrawdown(id);
  if (!d) throw notFound('Drawdown not found.');
  const store = await repo.loadEngineStore({ borrowerId: d.borrowerId });
  const b = store.borrowers[0];
  return Object.assign(calc.decorateDrawdown(d, b, store.payments), {
    borrowerName: b.name,
    payments: store.payments.filter((p) => p.drawdownId === id)
  });
}));

const { assertWithinLimit } = require('../ledger');

function readDrawdownInput(body) {
  return {
    ref: optStr(body.ref, 'PO / reference', { max: 80 }),
    poAmt: reqNum(body.poAmt, 'Amount', { positive: true, max: 1e13 }),
    bankDebit: reqDate(body.bankDebit, 'Debit date'),
    mode: oneOf(body.mode, 'Advance interest', MODES, 'none'),
    cd: optNum(body.cd, 'Custom advance days', 30, { min: 1, max: 3650 }),
    feePct: body.feePct == null || body.feePct === '' ? null : reqNum(body.feePct, 'Processing fee', { min: 0, max: 100 }),
    rem: optStr(body.rem, 'Remarks', { max: 255 })
  };
}

/* ---------------- create ---------------- */
router.post('/', H(async (req) => {
  const me = auth.requireWrite(req);
  const borrowerId = reqId(req.body.borrowerId, 'Borrower');
  const input = readDrawdownInput(req.body);

  const store = await repo.loadEngineStore({ borrowerId });
  const b = store.borrowers[0];
  if (!b) throw notFound('Borrower not found.');
  await book.assertCanDraw(b);
  if (input.bankDebit < b.sanctionDate) throw bad('The debit date cannot precede the sanction date (' + b.sanctionDate + ').');
  assertWithinLimit(store, borrowerId, input.poAmt);

  const d = calc.computeDrawdown(input, b);
  const r = await q(
    `INSERT INTO drawdowns (borrower_id, ref, po_amt, bank_debit, mode, cd, ad, adv, fee_pct, fee, gst_amt,
                            disbursed, out_prin, int_overhang, int_collected, loan_type, status, rem, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [borrowerId, d.ref, d.poAmt, d.bankDebit, d.mode, d.cd, d.ad, d.adv, d.feePct, d.fee, d.gstAmt,
      d.disbursed, d.outPrin, 0, 0, d.loanType, 'Open', d.rem, me.name]);

  await audit.log(req, 'drawdown.create', 'drawdown', r.insertId,
    me.name + ' disbursed ' + Math.round(d.disbursed) + ' to ' + b.name + (d.ref ? ' (' + d.ref + ')' : ''),
    { poAmt: d.poAmt, adv: d.adv, fee: d.fee, gst: d.gstAmt, net: d.disbursed });

  const after = await repo.loadEngineStore({ borrowerId });
  const fresh = after.drawdowns.find((x) => x.id === r.insertId);
  return calc.decorateDrawdown(fresh, b, after.payments);
}));

/* ---------------- update ----------------
   Financial fields are only editable while no payment has landed; after that
   only the reference and remarks can change, so history stays truthful. */
router.put('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Drawdown');
  const before = await repo.getDrawdown(id);
  if (!before) throw notFound('Drawdown not found.');

  const store = await repo.loadEngineStore({ borrowerId: before.borrowerId });
  const b = store.borrowers[0];
  const pays = store.payments.filter((p) => p.drawdownId === id);

  if (pays.length) {
    const ref = optStr(req.body.ref, 'PO / reference', { max: 80 });
    const rem = optStr(req.body.rem, 'Remarks', { max: 255 });
    await q('UPDATE drawdowns SET ref = ?, rem = ? WHERE id = ?', [ref, rem, id]);
    await audit.log(req, 'drawdown.update', 'drawdown', id, me.name + ' edited the reference/remarks of drawdown ' + id);
  } else {
    const input = readDrawdownInput(req.body);
    if (input.bankDebit < b.sanctionDate) throw bad('The debit date cannot precede the sanction date (' + b.sanctionDate + ').');
    assertWithinLimit(store, before.borrowerId, input.poAmt, id);
    const d = calc.computeDrawdown(input, b);
    await q(
      `UPDATE drawdowns SET ref=?, po_amt=?, bank_debit=?, mode=?, cd=?, ad=?, adv=?, fee_pct=?, fee=?, gst_amt=?,
                            disbursed=?, out_prin=?, loan_type=?, rem=? WHERE id=?`,
      [d.ref, d.poAmt, d.bankDebit, d.mode, d.cd, d.ad, d.adv, d.feePct, d.fee, d.gstAmt,
        d.disbursed, d.poAmt, d.loanType, d.rem, id]);
    await audit.log(req, 'drawdown.update', 'drawdown', id, me.name + ' revised drawdown ' + id + ' for ' + b.name,
      { from: { poAmt: before.poAmt, bankDebit: before.bankDebit }, to: { poAmt: d.poAmt, bankDebit: d.bankDebit } });
  }

  const after = await repo.loadEngineStore({ borrowerId: before.borrowerId });
  return calc.decorateDrawdown(after.drawdowns.find((x) => x.id === id), b, after.payments);
}));

/* ---------------- rotation ----------------
   At maturity the outstanding principal rolls into a fresh drawdown with a new
   tenure clock. The old drawdown is settled by a payment equal to its principal
   plus accrued interest — funded either in cash by the borrower or, when
   `capitaliseInterest` is set, by adding the interest to the new principal. */
router.post('/:id/rotate', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Drawdown');
  const old = await repo.getDrawdown(id);
  if (!old) throw notFound('Drawdown not found.');
  if (old.status === 'Repaid') throw bad('This drawdown is already closed — nothing to rotate.');

  const store = await repo.loadEngineStore({ borrowerId: old.borrowerId });
  const b = store.borrowers[0];
  await book.assertCanDraw(b);
  const date = optDate(req.body.date, 'Rotation date', calc.td());
  if (date < old.bankDebit) throw bad('The rotation date cannot precede the original debit date.');

  const accrued = calc.money(calc.accruedFor(old, b, date, store.payments));
  const capitalise = flag(req.body.capitaliseInterest);
  const newPrincipal = calc.money(old.outPrin + (capitalise ? accrued : 0));
  if (!(newPrincipal > 0)) throw bad('There is no outstanding principal to roll forward.');

  // The old drawdown closes as part of the same transaction, so its principal
  // is excluded when checking headroom for the replacement.
  assertWithinLimit(store, old.borrowerId, newPrincipal, id);

  const input = {
    ref: optStr(req.body.ref, 'PO / reference', { max: 80 }) || (old.ref ? old.ref + '-R' : ''),
    poAmt: newPrincipal, bankDebit: date,
    mode: oneOf(req.body.mode, 'Advance interest', MODES, 'none'),
    cd: optNum(req.body.cd, 'Custom advance days', 30, { min: 1, max: 3650 }),
    feePct: req.body.feePct == null || req.body.feePct === '' ? null : reqNum(req.body.feePct, 'Processing fee', { min: 0, max: 100 }),
    rem: optStr(req.body.rem, 'Remarks', { max: 255 }) || ('Rotation of ' + (old.ref || 'drawdown #' + old.id))
  };
  const nd = calc.computeDrawdown(input, b);
  const settlement = calc.money(old.outPrin + accrued);

  const result = await tx(async (cx) => {
    // 1. settle the old drawdown
    const ins = await cx.q(
      `INSERT INTO payments (borrower_id, drawdown_id, ref, pay_date, amount, int_adj, prin_adj, out_after, closed, kind, rem, created_by)
       VALUES (?,?,?,?,?,0,0,0,0,'rotation',?,?)`,
      [old.borrowerId, old.id, old.ref, date, settlement,
        'Rotation settlement' + (capitalise ? ' (interest capitalised)' : ' (interest paid in cash)'), me.name]);
    const pays = (await cx.q('SELECT * FROM payments WHERE drawdown_id = ? ORDER BY pay_date, id', [old.id])).map(repo.mapPayment);
    await repo.persistReplay(cx, old.id, calc.replayDrawdown(old, b, pays));

    // 2. open the replacement
    const r = await cx.q(
      `INSERT INTO drawdowns (borrower_id, ref, po_amt, bank_debit, mode, cd, ad, adv, fee_pct, fee, gst_amt,
                              disbursed, out_prin, int_overhang, int_collected, loan_type, status, rem, rotated_from, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,'Open',?,?,?)`,
      [old.borrowerId, nd.ref, nd.poAmt, nd.bankDebit, nd.mode, nd.cd, nd.ad, nd.adv, nd.feePct, nd.fee, nd.gstAmt,
        nd.disbursed, nd.poAmt, nd.loanType, nd.rem, old.id, me.name]);
    return { paymentId: ins.insertId, newId: r.insertId };
  });

  await audit.log(req, 'drawdown.rotate', 'drawdown', id,
    me.name + ' rotated ' + (old.ref || '#' + old.id) + ' into a new drawdown of ' + Math.round(newPrincipal) + ' for ' + b.name,
    { settlement, accrued, capitalise, newDrawdownId: result.newId });

  const after = await repo.loadEngineStore({ borrowerId: old.borrowerId });
  return {
    closed: calc.decorateDrawdown(after.drawdowns.find((x) => x.id === id), b, after.payments),
    created: calc.decorateDrawdown(after.drawdowns.find((x) => x.id === result.newId), b, after.payments),
    settlement, accrued, capitalised: capitalise
  };
}));

/* ---------------- delete ---------------- */
router.delete('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Drawdown');
  const d = await repo.getDrawdown(id);
  if (!d) throw notFound('Drawdown not found.');

  const [{ n }] = await q('SELECT COUNT(*) AS n FROM payments WHERE drawdown_id = ?', [id]);
  if (n > 0 && me.role !== 'director') {
    throw Object.assign(new Error('This drawdown has ' + n + ' payment(s) against it. Only the Director can delete it.'), { status: 403 });
  }
  const [{ r }] = await q('SELECT COUNT(*) AS r FROM drawdowns WHERE rotated_from = ?', [id]);
  if (r > 0) throw bad('This drawdown was rotated into a later one — delete the replacement first.');

  /* A rotation is one economic event in two halves: the settlement booked on
     the source drawdown and the replacement it funded. Deleting the
     replacement therefore has to unwind the settlement too, or the source
     would keep a repayment that nothing paid for. */
  let unwound = null;
  if (d.rotatedFrom) {
    const store = await repo.loadEngineStore({ borrowerId: d.borrowerId });
    const source = store.drawdowns.find((x) => x.id === d.rotatedFrom);
    const settlement = store.payments.find(
      (p) => p.drawdownId === d.rotatedFrom && p.kind === 'rotation' && p.date === d.bankDebit);
    await tx(async (cx) => {
      if (settlement) await cx.q('DELETE FROM payments WHERE id = ?', [settlement.id]);
      await cx.q('DELETE FROM drawdowns WHERE id = ?', [id]);
      if (source) {
        const pays = (await cx.q('SELECT * FROM payments WHERE drawdown_id = ? ORDER BY pay_date, id', [source.id])).map(repo.mapPayment);
        await repo.persistReplay(cx, source.id, calc.replayDrawdown(source, store.borrowers[0], pays));
      }
    });
    unwound = settlement ? { settlementId: settlement.id, sourceDrawdownId: d.rotatedFrom } : null;
  } else {
    await q('DELETE FROM drawdowns WHERE id = ?', [id]);   // cascades to its payments
  }

  await audit.log(req, 'drawdown.delete', 'drawdown', id,
    me.name + ' deleted drawdown ' + (d.ref || '#' + id) + ' and ' + n + ' payment(s)' +
    (unwound ? ', unwinding the rotation of #' + unwound.sourceDrawdownId : ''), unwound);
  return { ok: true, unwoundRotation: unwound };
}));

module.exports = router;
