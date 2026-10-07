'use strict';
/* Writes that open a tranche on the book — shared by the direct drawdown route
   and by the disbursement queue, so a payout made through either is identical. */
const repo = require('./repo');
const calc = require('./calc');
const { bad } = require('./http');

/* A new or enlarged drawdown must fit inside the sanctioned limit. */
function assertWithinLimit(store, borrowerId, addingAmount, excludeDrawdownId = null) {
  const limit = calc.currentLimit(store, borrowerId);
  const open = store.drawdowns
    .filter((d) => d.borrowerId === borrowerId && d.status !== 'Repaid' && d.id !== excludeDrawdownId)
    .reduce((s, d) => s + (+d.outPrin || 0), 0);
  const available = limit - open;
  if (addingAmount > available + 0.005) {
    throw bad('This drawdown of ₹' + Math.round(addingAmount).toLocaleString('en-IN') +
      ' exceeds the available limit of ₹' + Math.round(Math.max(0, available)).toLocaleString('en-IN') +
      '. Enhance the sanctioned limit first.');
  }
}

/* INSERT a computed drawdown (calc.computeDrawdown output) and return its id. */
async function insertDrawdown(run, borrowerId, d, createdBy, rotatedFrom = null) {
  const r = await run(
    `INSERT INTO drawdowns (borrower_id, ref, po_amt, bank_debit, mode, cd, ad, adv, fee_pct, fee, gst_amt,
                            disbursed, out_prin, int_overhang, int_collected, loan_type, status, rem, rotated_from, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,'Open',?,?,?)`,
    [borrowerId, d.ref, d.poAmt, d.bankDebit, d.mode, d.cd, d.ad, d.adv, d.feePct, d.fee, d.gstAmt,
      d.disbursed, d.poAmt, d.loanType, d.rem, rotatedFrom, createdBy]);
  return r.insertId;
}

/* Settle `old` with a rotation receipt and open its replacement, inside the
   caller's transaction. Returns { paymentId, newId }. */
async function rotate(cx, { old, borrower, newDrawdown, date, settlement, note, createdBy }) {
  const ins = await cx.q(
    `INSERT INTO payments (borrower_id, drawdown_id, ref, pay_date, amount, int_adj, prin_adj, out_after, closed, kind, rem, created_by)
     VALUES (?,?,?,?,?,0,0,0,0,'rotation',?,?)`,
    [old.borrowerId, old.id, old.ref, date, settlement, note, createdBy]);
  const pays = (await cx.q('SELECT * FROM payments WHERE drawdown_id = ? ORDER BY pay_date, id', [old.id])).map(repo.mapPayment);
  await repo.persistReplay(cx, old.id, calc.replayDrawdown(old, borrower, pays));
  const newId = await insertDrawdown(cx.q, old.borrowerId, newDrawdown, createdBy, old.id);
  return { paymentId: ins.insertId, newId };
}

module.exports = { assertWithinLimit, insertDrawdown, rotate };
