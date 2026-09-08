'use strict';
/* Payments — the interest→principal waterfall.

   Every write re-derives the drawdown from its full payment history
   (calc.replayDrawdown), so a back-dated, edited or deleted receipt leaves the
   account in exactly the state it would have been in had the payments always
   arrived in that order. */
const express = require('express');
const { q, tx } = require('../db/pool');
const repo = require('../repo');
const calc = require('../calc');
const auth = require('../auth');
const audit = require('../audit');
const { H, bad, notFound, optStr, reqNum, reqDate, optDate, reqId, optId } = require('../http');

const router = express.Router();

/* ---------------- list ---------------- */
router.get('/', H(async (req) => {
  auth.requireUser(req);
  const borrowerId = optId(req.query.borrowerId, 'Borrower');
  const store = await repo.loadEngineStore(borrowerId ? { borrowerId } : {});
  const bName = new Map(store.borrowers.map((b) => [b.id, b.name]));
  return store.payments
    .map((p) => Object.assign({}, p, { borrowerName: bName.get(p.borrowerId) }))
    .sort((a, c) => (a.date === c.date ? c.id - a.id : (a.date < c.date ? 1 : -1)));
}));

/* Resolve and validate the inputs shared by preview and create. */
async function resolve(body, { excludePaymentId = null } = {}) {
  const drawdownId = reqId(body.drawdownId, 'Drawdown');
  const dd = await repo.getDrawdown(drawdownId);
  if (!dd) throw notFound('Drawdown not found.');

  const store = await repo.loadEngineStore({ borrowerId: dd.borrowerId });
  const b = store.borrowers[0];
  const date = optDate(body.date, 'Credit date', calc.td());
  if (date < dd.bankDebit) throw bad('The payment date cannot precede the drawdown date (' + dd.bankDebit + ').');
  const amount = reqNum(body.amount, 'Amount received', { positive: true, max: 1e13 });

  /* Build the state the drawdown was in immediately before this payment, so a
     back-dated receipt is priced against the right outstanding. */
  const history = store.payments
    .filter((p) => p.drawdownId === drawdownId && p.id !== excludePaymentId)
    .filter((p) => p.date < date || (p.date === date && excludePaymentId == null));
  const priorReplay = calc.replayDrawdown(dd, b, history);
  const asOfDrawdown = Object.assign({}, dd, priorReplay.state);

  const alloc = calc.allocatePayment(asOfDrawdown, b, amount, date, priorReplay.payments);
  const due = calc.money(asOfDrawdown.outPrin + alloc.accrued);
  return { dd, b, store, date, amount, alloc, due, outstandingBefore: asOfDrawdown.outPrin, priorCount: history.length };
}

router.post('/preview', H(async (req) => {
  auth.requireUser(req);
  const r = await resolve(req.body);
  return {
    alloc: r.alloc, accruedToDate: r.alloc.accrued, outstandingBefore: r.outstandingBefore,
    totalDue: r.due, overpayment: calc.money(Math.max(0, r.amount - r.due)),
    date: r.date, amount: r.amount, loanType: r.dd.loanType
  };
}));

/* ---------------- create ---------------- */
router.post('/', H(async (req) => {
  const me = auth.requireWrite(req);
  const r = await resolve(req.body);
  if (r.amount > r.due + 0.5) {
    throw bad('₹' + Math.round(r.amount).toLocaleString('en-IN') + ' exceeds the total due of ₹' +
      Math.round(r.due).toLocaleString('en-IN') + ' on this drawdown as at ' + r.date + '.');
  }
  const rem = optStr(req.body.rem, 'Remarks', { max: 255 });

  const paymentId = await tx(async (cx) => {
    const ins = await cx.q(
      `INSERT INTO payments (borrower_id, drawdown_id, ref, pay_date, amount, int_adj, prin_adj, out_after, closed, kind, rem, created_by)
       VALUES (?,?,?,?,?,0,0,0,0,?,?,?)`,
      [r.dd.borrowerId, r.dd.id, r.dd.ref, r.date, r.amount, r.alloc.kind, rem, me.name]);
    const pays = (await cx.q('SELECT * FROM payments WHERE drawdown_id = ? ORDER BY pay_date, id', [r.dd.id])).map(repo.mapPayment);
    await repo.persistReplay(cx, r.dd.id, calc.replayDrawdown(r.dd, r.b, pays));
    return ins.insertId;
  });

  await audit.log(req, 'payment.create', 'payment', paymentId,
    me.name + ' recorded ' + Math.round(r.amount) + ' from ' + r.b.name + (r.dd.ref ? ' against ' + r.dd.ref : ''),
    { interest: r.alloc.intAdj, principal: r.alloc.prinAdj, closed: r.alloc.closed });

  const after = await repo.loadEngineStore({ borrowerId: r.dd.borrowerId });
  return {
    payment: after.payments.find((p) => p.id === paymentId),
    drawdown: calc.decorateDrawdown(after.drawdowns.find((d) => d.id === r.dd.id), r.b, after.payments),
    summary: calc.borrowerSummary(after, r.dd.borrowerId)
  };
}));

/* ---------------- update ---------------- */
router.put('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Payment');
  const before = await repo.getPayment(id);
  if (!before) throw notFound('Payment not found.');

  const r = await resolve({ ...req.body, drawdownId: before.drawdownId }, { excludePaymentId: id });
  if (r.amount > r.due + 0.5) {
    throw bad('₹' + Math.round(r.amount).toLocaleString('en-IN') + ' exceeds the total due of ₹' +
      Math.round(r.due).toLocaleString('en-IN') + ' on this drawdown as at ' + r.date + '.');
  }
  const rem = optStr(req.body.rem, 'Remarks', { max: 255 });

  await tx(async (cx) => {
    await cx.q('UPDATE payments SET pay_date = ?, amount = ?, rem = ? WHERE id = ?', [r.date, r.amount, rem, id]);
    const pays = (await cx.q('SELECT * FROM payments WHERE drawdown_id = ? ORDER BY pay_date, id', [before.drawdownId])).map(repo.mapPayment);
    await repo.persistReplay(cx, before.drawdownId, calc.replayDrawdown(r.dd, r.b, pays));
  });

  await audit.log(req, 'payment.update', 'payment', id, me.name + ' revised payment #' + id + ' for ' + r.b.name,
    { from: { amount: before.amount, date: before.date }, to: { amount: r.amount, date: r.date } });

  const after = await repo.loadEngineStore({ borrowerId: before.borrowerId });
  return {
    payment: after.payments.find((p) => p.id === id),
    drawdown: calc.decorateDrawdown(after.drawdowns.find((d) => d.id === before.drawdownId), r.b, after.payments),
    summary: calc.borrowerSummary(after, before.borrowerId)
  };
}));

/* ---------------- delete (reversal) ---------------- */
router.delete('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Payment');
  const p = await repo.getPayment(id);
  if (!p) throw notFound('Payment not found.');

  const store = await repo.loadEngineStore({ borrowerId: p.borrowerId });
  const b = store.borrowers[0];
  const dd = store.drawdowns.find((d) => d.id === p.drawdownId);

  await tx(async (cx) => {
    await cx.q('DELETE FROM payments WHERE id = ?', [id]);
    const pays = (await cx.q('SELECT * FROM payments WHERE drawdown_id = ? ORDER BY pay_date, id', [p.drawdownId])).map(repo.mapPayment);
    await repo.persistReplay(cx, p.drawdownId, calc.replayDrawdown(dd, b, pays));
  });

  await audit.log(req, 'payment.delete', 'payment', id,
    me.name + ' reversed a payment of ' + Math.round(p.amount) + ' from ' + b.name + ' dated ' + p.date);

  const after = await repo.loadEngineStore({ borrowerId: p.borrowerId });
  return { ok: true, summary: calc.borrowerSummary(after, p.borrowerId) };
}));

module.exports = router;
