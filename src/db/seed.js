'use strict';
/* ============================================================================
   Seed data.

   1. The three staff accounts, with bcrypt-hashed passwords taken from .env.
   2. One reference borrower — PML Pvt Ltd — built through the real engine, so
      the ledger, MIS and dashboard are populated on a fresh install and every
      figure is one the engine actually produced.

   Both steps are skipped when their table already holds rows, so `db:migrate`
   is safe to run against a live database.
   ========================================================================== */
const config = require('../config');
const { q, tx } = require('./pool');
const calc = require('../calc');
const { hashPassword } = require('../auth');

const offsetISO = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

const STAFF = [
  { name: 'Sonali Bansal', email: 'sonali@valuefin.in', role: 'director', pw: () => config.seedPasswords.director },
  { name: 'Manager', email: 'manager@valuefin.in', role: 'manager', pw: () => config.seedPasswords.manager },
  { name: 'Ujjwal Mahajan', email: 'ujjwal@valuefin.in', role: 'analyst', pw: () => config.seedPasswords.analyst }
];

/* Who the reference borrower's history is attributed to: day-to-day entries are
   the Manager's, the limit enhancement is the Director's credit decision. */
const OPS = STAFF.find((s) => s.role === 'manager').name;
const CREDIT = STAFF.find((s) => s.role === 'director').name;

async function seedUsers() {
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM users');
  if (n > 0) return 'users: ' + n + ' already present, skipped';
  for (const s of STAFF) {
    const pw = s.pw();
    if (!pw) throw new Error('Seed password missing for the ' + s.role + ' account — set it in backend/.env');
    await q('INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, ?, ?)',
      [s.name, s.email, s.role, await hashPassword(pw)]);
  }
  return 'users: created ' + STAFF.map((s) => s.email + ' (' + s.role + ')').join(', ');
}

async function seedReferenceBorrower() {
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM borrowers');
  if (n > 0) return 'borrowers: ' + n + ' already present, reference seed skipped';

  return tx(async (cx) => {
    const b = {
      slug: 'pml-pvt-ltd', name: 'PML Pvt Ltd', biz: 'FMCG distribution', loanType: 'po',
      limit: 10000000, rate: 18, penRate: 6, procFeePct: 1.5, gstPct: 18,
      tenure: 90, tenureUnit: 'days', sanctionDate: offsetISO(-150)
    };
    const ins = await cx.q(
      `INSERT INTO borrowers (slug, name, biz, loan_type, base_limit, rate, pen_rate, proc_fee_pct, gst_pct,
                              tenure, tenure_unit, sanction_date, contact_name, contact_email, contact_phone,
                              pan, gstin, is_sample, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [b.slug, b.name, b.biz, b.loanType, b.limit, b.rate, b.penRate, b.procFeePct, b.gstPct,
        b.tenure, b.tenureUnit, b.sanctionDate, 'Rakesh Menon', 'accounts@pml.example', '+91 98200 00000',
        'AACCP1234M', '27AACCP1234M1ZP', OPS]
    );
    b.id = ins.insertId;

    const insertDrawdown = async (input) => {
      const d = calc.computeDrawdown(input, b);
      const r = await cx.q(
        `INSERT INTO drawdowns (borrower_id, ref, po_amt, bank_debit, mode, cd, ad, adv, fee_pct, fee, gst_amt,
                                disbursed, out_prin, int_overhang, int_collected, loan_type, status, rem, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [b.id, d.ref, d.poAmt, d.bankDebit, d.mode, d.cd, d.ad, d.adv, d.feePct, d.fee, d.gstAmt,
          d.disbursed, d.outPrin, d.intOverhang, d.intCollected, d.loanType, d.status, d.rem, OPS]
      );
      return Object.assign(d, { id: r.insertId, borrowerId: b.id });
    };

    // Cycle 1 — disbursed 120 days ago, settled in full 34 days ago.
    const d1 = await insertDrawdown({ ref: 'PML/PO-2401', poAmt: 4000000, bankDebit: offsetISO(-120), mode: '1m', rem: 'First cycle — anchor PO' });
    const payDate = offsetISO(-34);
    const amt1 = calc.money(d1.outPrin + calc.poAccrued(d1, b, payDate).total);
    const a1 = calc.allocatePayment(d1, b, amt1, payDate, []);
    await cx.q(
      `INSERT INTO payments (borrower_id, drawdown_id, ref, pay_date, amount, int_adj, prin_adj, out_after, closed, kind, rem, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, ?)`,
      [b.id, d1.id, d1.ref, payDate, amt1, a1.intAdj, a1.prinAdj, a1.outAfter, a1.closed ? 1 : 0, a1.kind, 'Buyer settled — full closure', OPS]
    );
    await cx.q('UPDATE drawdowns SET out_prin = ?, int_overhang = ?, int_collected = ?, status = ? WHERE id = ?',
      [a1.outAfter, a1.overhang, a1.intAdj, a1.closed ? 'Repaid' : 'Open', d1.id]);

    // Cycle 2 — disbursed 40 days ago, still running with one part payment.
    const d2 = await insertDrawdown({ ref: 'PML/PO-2402', poAmt: 3500000, bankDebit: offsetISO(-40), mode: '30d', rem: 'Second cycle — running' });
    const payDate2 = offsetISO(-8);
    const a2 = calc.allocatePayment(d2, b, 1000000, payDate2, []);
    await cx.q(
      `INSERT INTO payments (borrower_id, drawdown_id, ref, pay_date, amount, int_adj, prin_adj, out_after, closed, kind, rem, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, ?)`,
      [b.id, d2.id, d2.ref, payDate2, 1000000, a2.intAdj, a2.prinAdj, a2.outAfter, a2.closed ? 1 : 0, a2.kind, 'Part recovery against invoices', OPS]
    );
    await cx.q('UPDATE drawdowns SET out_prin = ?, int_overhang = ?, int_collected = ?, status = ? WHERE id = ?',
      [a2.outAfter, a2.overhang, a2.intAdj, a2.closed ? 'Repaid' : 'Open', d2.id]);

    // A sanctioned-limit enhancement, so the limit-history view has content.
    await cx.q(
      'INSERT INTO limit_history (borrower_id, event_date, incr_amt, note, created_by) VALUES (?,?,?,?,?)',
      [b.id, offsetISO(-60), 2500000, 'Enhancement after Q3 review — clean track record', CREDIT]
    );

    return 'borrowers: created reference "PML Pvt Ltd" with 2 drawdowns, 2 payments, 1 limit enhancement';
  });
}

async function seed() {
  const report = [];
  report.push(await seedUsers());
  report.push(await seedReferenceBorrower());
  return report;
}

module.exports = { seed, seedUsers, seedReferenceBorrower, STAFF };
