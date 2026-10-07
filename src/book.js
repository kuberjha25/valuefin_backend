'use strict';
/* Book-level context shared by origination, disbursement, monitoring and the
   reports: what is live on the book, who it is lent to, and whether a borrower
   may be paid out to right now. */
const { q } = require('./db/pool');
const repo = require('./repo');
const calc = require('./calc');
const { bad, fail } = require('./http');

/* Live exposure from the engine store: outstanding principal of every open
   tranche, by borrower, by product and by backing fund. */
async function liveBook(store) {
  store = store || await repo.loadEngineStore();
  const byBorrower = new Map();
  store.drawdowns.filter((d) => d.status !== 'Repaid').forEach((d) => {
    byBorrower.set(d.borrowerId, (byBorrower.get(d.borrowerId) || 0) + (+d.outPrin || 0));
  });
  let total = 0, bullet = 0;
  const vcExposure = {};
  const vcBorrowers = {};
  store.borrowers.forEach((b) => {
    const out = byBorrower.get(b.id) || 0;
    total += out;
    if (b.product === 'bullet') bullet += out;
    (b.vcs || []).forEach((vc) => {
      vcExposure[vc] = (vcExposure[vc] || 0) + out;
      if (out > 0) (vcBorrowers[vc] = vcBorrowers[vc] || []).push(b.name);
    });
  });
  return {
    store, byBorrower, liveBook: calc.money(total), bulletOutstanding: calc.money(bullet), vcExposure, vcBorrowers,
    /* Exposure to the same group: a borrower sharing the PAN, or the same legal name. */
    groupExposure: ({ pan, name }) => {
      const p = String(pan || '').trim().toUpperCase(), n = String(name || '').trim().toLowerCase();
      return calc.money(store.borrowers
        .filter((b) => (p && String(b.pan || '').toUpperCase() === p) || (n && b.name.toLowerCase() === n))
        .reduce((s, b) => s + (byBorrower.get(b.id) || 0), 0));
    }
  };
}

const monthKey = (d) => d.toISOString().slice(0, 7);
const previousMonth = (today = new Date()) => monthKey(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)));

/* May this borrower be paid out to? A Director's stop is absolute. A Rocket Fuel
   borrower additionally owes last month's MIS (once the tenth has passed) and
   must not be reporting under six months of runway. */
async function assertCanDraw(borrower, today = new Date()) {
  if (borrower.status === 'closed') throw bad('This facility is closed — reopen it before disbursing.');
  if (borrower.stopDrawdowns) {
    throw bad('Drawdowns are stopped for ' + borrower.name + (borrower.stopReason ? ' — ' + borrower.stopReason : '') +
      '. Only a Director can lift the stop.');
  }
  if (borrower.product !== 'rocket_fuel') return;

  const prev = previousMonth(today);
  const sanctioned = String(borrower.sanctionDate || '').slice(0, 7);
  if (today.getUTCDate() > 10 && sanctioned && sanctioned <= prev) {
    const filed = await q('SELECT id FROM borrower_mis WHERE borrower_id = ? AND month = ? LIMIT 1', [borrower.id, prev]);
    if (!filed.length) throw bad(borrower.name + ' has not filed its MIS for ' + prev + ' — a missing month blocks the next Rocket Fuel drawdown.');
  }
  const latest = await q('SELECT month, burn, closing_cash FROM borrower_mis WHERE borrower_id = ? ORDER BY month DESC LIMIT 1', [borrower.id]);
  if (latest.length && +latest[0].burn > 0) {
    const runway = +latest[0].closing_cash / +latest[0].burn;
    if (runway < 6) {
      throw bad(borrower.name + ' reported ' + runway.toFixed(1) + ' months of runway for ' + latest[0].month +
        ' — below six months, so policy stops further drawdowns.');
    }
  }
}

/* Maker ≠ checker — unless the maker is the only active Director, in which case a
   one-person desk would deadlock on its own work. */
async function assertChecker(me, raisedById, what) {
  if (raisedById == null || raisedById !== me.id) return;
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM users WHERE role = 'director' AND active = 1 AND id <> ?", [me.id]);
  if (n > 0) throw bad('You raised this ' + (what || 'request') + ' — another Director has to decide it.');
}

module.exports = { liveBook, assertCanDraw, assertChecker, previousMonth, monthKey };
