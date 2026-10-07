'use strict';
/* ============================================================================
   Valuefin Desk — calculation engine (pure, no I/O)

   Ported line-for-line in behaviour from the production po_finance_cloud.html
   loan tool so every number matches: one-day-inclusive day count, 365-day
   daily rate, advance-interest modes, processing fee + GST, PO overdue/penal
   accrual, Interest-Only accrual, interest→principal payment waterfall,
   Newton-Raphson IRR, and the consolidated ledger + per-borrower statement.

   Every function here takes plain objects and returns plain objects. The
   "store" argument is the in-memory shape produced by repo.loadEngineStore().
   ========================================================================== */

const money = (n) => Math.round((+n || 0) * 100) / 100;          // 2dp, no float dust
const dr = (r) => (+r || 0) / 100 / 365;                          // daily rate (365-day year)
const td = () => new Date().toISOString().slice(0, 10);
const di = (d1, d2) => Math.round((new Date(d2) - new Date(d1)) / 86400000) + 1; // inclusive both ends
const addYearISO = (d) => { if (!d) return ''; const x = new Date(d); x.setFullYear(x.getFullYear() + 1); return x.toISOString().slice(0, 10); };
const addDaysISO = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

function tenureDays(b) {
  const tn = parseFloat(b.tenure) || 90;
  return b.tenureUnit === 'months' ? Math.round(tn * 30.4375) : tn;
}
/* The date a drawdown falls overdue: debit date + tenure (day count inclusive). */
function dueDate(dd, b) { return addDaysISO(dd.bankDebit, tenureDays(b) - 1); }

/* advance-interest window: none | 30d | 1m | 2m | custom days */
function advance(amt, rate, mode, cd) {
  amt = +amt || 0; rate = +rate || 0;
  if (mode === 'none') return { adv: 0, ad: 0 };
  if (mode === '30d') return { adv: amt * dr(rate) * 30, ad: 30 };
  if (mode === '1m') return { adv: amt * (rate / 100 / 12), ad: 30 };
  if (mode === '2m') return { adv: amt * (rate / 100 / 12) * 2, ad: 61 };
  const d = +cd || 30; return { adv: amt * dr(rate) * d, ad: d };
}
function feeCalc(amt, feePct, gstPct) {
  const f = (+amt || 0) * (+feePct || 0) / 100;
  const g = f * (+gstPct || 0) / 100;
  return { fee: f, gst: g, total: f + g };
}

/* Build a drawdown record from raw inputs + its borrower. */
function computeDrawdown(input, b) {
  const poAmt = money(input.poAmt);
  const mode = ['none', '30d', '1m', '2m', 'custom'].includes(input.mode) ? input.mode : 'none';
  const { adv, ad } = advance(poAmt, b.rate, mode, input.cd);
  const feePct = input.feePct != null && input.feePct !== '' ? +input.feePct : (+b.procFeePct || 0);
  const { fee, gst } = feeCalc(poAmt, feePct, b.gstPct);
  return {
    ref: String(input.ref || '').trim(), poAmt, bankDebit: input.bankDebit || td(),
    mode, cd: mode === 'custom' ? (+input.cd || 30) : null, ad, adv: money(adv),
    feePct, fee: money(fee), gstAmt: money(gst), disbursed: money(poAmt - adv - fee - gst),
    outPrin: poAmt, intOverhang: 0, intCollected: 0,
    loanType: b.loanType || 'po', status: 'Open', rem: String(input.rem || '').trim()
  };
}

/* PO Finance interest accrued on a drawdown up to a date (incl. penal + carried overhang) */
function poAccrued(dd, b, toDate) {
  const days = di(dd.bankDebit, toDate);
  const op = +dd.outPrin || 0;
  const ov = +dd.intOverhang || 0;
  const ten = tenureDays(b);
  const wT = Math.min(days, ten);
  const exD = Math.max(0, wT - (+dd.ad || 0));
  const exI = exD > 0 ? op * dr(b.rate) * exD : 0;
  const odD = Math.max(0, days - ten);
  const cr = (+b.rate || 0) + (+b.penRate || 0);
  const odC = odD > 0 ? op * dr(cr) * odD : 0;
  return { days, exD, exI, odD, cr, penal: odC, interest: exI, overhang: ov, total: exI + odC + ov };
}

/* Interest-Only accrual: advance covers first `ad` days, periodic interest thereafter */
function ioAccrued(dd, b, toDate) {
  const days = di(dd.bankDebit, toDate);
  const ad = +dd.ad || 0;
  const principal = +dd.poAmt || 0;
  const billable = Math.max(0, days - ad);
  return principal * dr(b.rate || 18) * billable;
}
function ioCollected(ddId, payments) {
  return payments.filter((p) => p.drawdownId === ddId).reduce((s, p) => s + (+p.intAdj || 0), 0);
}
function ioNetDue(dd, b, toDate, payments) {
  return Math.max(0, ioAccrued(dd, b, toDate) - ioCollected(dd.id, payments));
}

/* Interest accrued to a date, whichever product this drawdown is. */
function accruedFor(dd, b, toDate, payments) {
  return dd.loanType === 'io' ? ioNetDue(dd, b, toDate, payments || []) : poAccrued(dd, b, toDate).total;
}

/* Unified payment waterfall — interest (incl. penal + overhang) first, then principal. */
function allocatePayment(dd, b, amount, date, payments) {
  amount = money(amount);
  if (dd.loanType === 'io') {
    const accrued = ioAccrued(dd, b, date);
    const collected = ioCollected(dd.id, payments);
    const intDueNet = Math.max(0, accrued - collected);
    const intAdj = Math.min(amount, intDueNet);
    const prinAdj = Math.min(Math.max(0, amount - intAdj), +dd.outPrin || 0);
    const outAfter = Math.max(0, (+dd.outPrin || 0) - prinAdj);
    return { accrued: intDueNet, intAdj: money(intAdj), prinAdj: money(prinAdj), outAfter: money(outAfter),
      overhang: 0, closed: outAfter < 0.005 && prinAdj > 0, kind: prinAdj > 0 ? 'io_close' : 'io_interest' };
  }
  const acc = poAccrued(dd, b, date);
  const iDue = Math.max(0, acc.total);
  let intAdj = 0, prinAdj = 0, overhang = 0;
  if (amount >= iDue) { intAdj = iDue; prinAdj = Math.min(amount - iDue, +dd.outPrin || 0); }
  else { intAdj = amount; overhang = iDue - amount; }
  const outAfter = Math.max(0, (+dd.outPrin || 0) - prinAdj);
  return { accrued: money(iDue), intAdj: money(intAdj), prinAdj: money(prinAdj), outAfter: money(outAfter),
    overhang: money(overhang), closed: outAfter < 0.005 && overhang < 0.005, kind: 'po' };
}

/* Recompute a drawdown and every one of its payments from scratch, in date
   order. Used after a payment is deleted, back-dated or edited so the account
   never drifts out of sync with its own history. */
function replayDrawdown(dd, b, payments) {
  const ordered = payments.slice().sort((a, c) => (a.date === c.date ? a.id - c.id : (a.date < c.date ? -1 : 1)));
  const work = Object.assign({}, dd, { outPrin: +dd.poAmt || 0, intOverhang: 0, intCollected: 0, status: 'Open' });
  const prior = [];
  const applied = ordered.map((p) => {
    const a = allocatePayment(work, b, p.amount, p.date, prior);
    work.outPrin = a.outAfter;
    work.intOverhang = a.overhang || 0;
    work.intCollected = money(work.intCollected + a.intAdj);
    work.status = a.closed ? 'Repaid' : 'Open';
    // 'rotation' is a provenance marker, not an allocation result — keep it.
    const kind = p.kind === 'rotation' ? 'rotation' : a.kind;
    const out = Object.assign({}, p, { intAdj: a.intAdj, prinAdj: a.prinAdj, outAfter: a.outAfter, closed: a.closed, kind });
    prior.push(out);
    return out;
  });
  return {
    state: { outPrin: work.outPrin, intOverhang: work.intOverhang, intCollected: work.intCollected, status: work.status },
    payments: applied
  };
}

/* RBI IRACP bucket from days past tenure. Interest-Only tranches have no
   amortisation schedule to fall behind, so they stay Standard. */
function smaBucket(overdueDays) {
  if (overdueDays <= 0) return 'Standard';
  if (overdueDays <= 30) return 'SMA-0';
  if (overdueDays <= 60) return 'SMA-1';
  if (overdueDays <= 90) return 'SMA-2';
  return 'NPA';
}
const SMA_KEYS = ['Standard', 'SMA-0', 'SMA-1', 'SMA-2', 'NPA'];

/* What it costs to close a drawdown on a chosen date, with the working. `mode`
   is 'keep' (the advance stays earned) or 'refund' (unused advance days are
   returned). Recording the closure is an ordinary receipt for `total`. */
function settlement(dd, b, payments, date, mode) {
  const refund = mode === 'refund';
  const days = di(dd.bankDebit, date);
  const principal = money(+dd.outPrin || 0);
  const base = { date, days, advanceDays: +dd.ad || 0, loanType: dd.loanType, principal, overdueDays: 0,
    interestPlain: 0, penal: 0, carriedOverhang: 0, accrued: 0, collected: 0, overpaid: 0,
    unusedAdvanceDays: null, advanceRefund: 0 };

  if (dd.loanType === 'io') {
    const accrued = money(ioAccrued(dd, b, date));
    const collected = money(ioCollected(dd.id, payments || []));
    const overpaid = money(Math.max(0, collected - accrued));
    const advanceRefund = refund ? overpaid : 0;
    return Object.assign(base, { accrued, collected, overpaid, advanceRefund,
      total: money(Math.max(0, principal + Math.max(0, accrued - collected) - advanceRefund)) });
  }

  const a = poAccrued(dd, b, date);
  const unusedAdvanceDays = Math.max(0, (+dd.ad || 0) - days);
  const advanceRefund = refund ? money((+dd.poAmt || 0) * dr(b.rate) * unusedAdvanceDays) : 0;
  return Object.assign(base, {
    overdueDays: a.odD, interestPlain: money(a.exI), penal: money(a.penal), carriedOverhang: money(a.overhang),
    unusedAdvanceDays, advanceRefund,
    total: money(Math.max(0, principal + a.exI + a.penal + a.overhang - advanceRefund))
  });
}

/* Decorate a drawdown with live accrual for the API/UI. */
function decorateDrawdown(dd, b, payments, asOf = td()) {
  const acc = dd.loanType === 'io'
    ? { total: ioNetDue(dd, b, asOf, payments || []), days: di(dd.bankDebit, asOf), odD: 0 }
    : poAccrued(dd, b, asOf);
  const repaid = dd.status === 'Repaid';
  return Object.assign({}, dd, {
    accrued: repaid ? 0 : money(acc.total),
    daysOpen: acc.days,
    overdueDays: repaid ? 0 : (acc.odD || 0),
    dueDate: dueDate(dd, b),
    dueTotal: repaid ? 0 : money((+dd.outPrin || 0) + acc.total),
    sma: repaid ? 'Closed' : (dd.loanType === 'io' ? 'Standard' : smaBucket(acc.odD || 0))
  });
}

/* current sanctioned limit = base + approved increases */
function currentLimit(store, bid) {
  const b = store.borrowers.find((x) => x.id === bid);
  if (!b) return 0;
  const inc = (store.limitHistory || []).filter((l) => l.borrowerId === bid).reduce((s, l) => s + (+l.incrAmt || 0), 0);
  return money((+b.limit || 0) + inc);
}

/* 1-year renewal status from the latest sanction / limit event */
function renewalStatus(store, bid) {
  const b = store.borrowers.find((x) => x.id === bid);
  if (!b) return null;
  const evts = [...(b.sanctionDate ? [{ date: b.sanctionDate }] : []),
    ...(store.limitHistory || []).filter((l) => l.borrowerId === bid).map((l) => ({ date: l.date }))]
    .sort((a, c) => (c.date > a.date ? 1 : -1));
  if (!evts.length) return null;
  const rd = addYearISO(evts[0].date);
  const daysLeft = di(td(), rd) - 1;
  if (daysLeft < 0) return { status: 'overdue', renewDate: rd, daysLeft };
  if (daysLeft <= 30) return { status: 'warn', renewDate: rd, daysLeft };
  return { status: 'ok', renewDate: rd, daysLeft };
}

/* ---- IRR (Newton-Raphson, daily discounting) ---- */
function calcIRR(flows) {
  if (!flows || flows.length < 2) return null;
  const maxT = Math.max(...flows.map((c) => c.t));
  if (maxT <= 0) return null;
  let r = 0.15;
  for (let i = 0; i < 100; i++) {
    let npv = 0, dnpv = 0;
    flows.forEach((cf) => {
      const disc = Math.pow(1 + r, cf.t / 365);
      npv += cf.amount / disc;
      dnpv -= cf.amount * (cf.t / 365) / ((1 + r) * disc);
    });
    if (Math.abs(npv) < 0.01) break;
    if (!dnpv) break;
    r = r - npv / dnpv;
    if (r < -0.999) r = -0.999;
    if (r > 100) r = 100;
  }
  return isFinite(r) ? r * 100 : null;
}
function borrowerCashFlows(store, bid) {
  const dds = store.drawdowns.filter((d) => d.borrowerId === bid);
  if (!dds.length) return [];
  let earliest = null;
  dds.forEach((d) => { const t = new Date(d.bankDebit); if (!earliest || t < earliest) earliest = t; });
  const flows = [];
  dds.forEach((d) => {
    const t = Math.round((new Date(d.bankDebit) - earliest) / 86400000);
    flows.push({ t, amount: -(+d.poAmt || 0) });     // cash out = full principal disbursed against
    if (d.fee > 0) flows.push({ t, amount: +d.fee || 0 });
    if (d.adv > 0) flows.push({ t, amount: +d.adv || 0 });
  });
  store.payments.filter((p) => p.borrowerId === bid).forEach((p) => {
    const t = Math.round((new Date(p.date) - earliest) / 86400000);
    flows.push({ t, amount: +p.amount || 0 });
  });
  /* mark-to-date: value each still-open drawdown at today = outstanding principal
     + interest accrued to date, so IRR reflects yield earned so far rather than
     treating an un-repaid (but performing) loan as a total loss. */
  const b = store.borrowers.find((x) => x.id === bid);
  const today = td();
  const tNow = Math.round((new Date(today) - earliest) / 86400000);
  dds.filter((d) => d.status !== 'Repaid').forEach((d) => {
    const value = (+d.outPrin || 0) + accruedFor(d, b, today, store.payments);
    if (value > 0) flows.push({ t: tNow, amount: value });
  });
  return flows;
}

/* ---- consolidated ledger (auto-generated) ---- */
function buildLedger(store, { borrowerId, from, to, type } = {}) {
  const bName = (id) => (store.borrowers.find((b) => b.id === id) || {}).name || '—';
  let e = [];
  store.drawdowns.forEach((d) => {
    e.push({ id: 'd' + d.id, date: d.bankDebit, dir: 'out', type: d.rotatedFrom ? 'Rotation' : 'Disbursement',
      borrowerId: d.borrowerId, borrowerName: bName(d.borrowerId), ref: d.ref || '',
      amount: d.disbursed, fee: d.fee || 0, gst: d.gstAmt || 0, adv: d.adv || 0,
      intAdj: null, prinAdj: null, outAfter: d.poAmt, rem: d.rem || '' });
  });
  store.payments.forEach((p) => {
    const d = store.drawdowns.find((x) => x.id === p.drawdownId) || {};
    const sub = p.kind === 'rotation' ? 'Rotation Settlement'
      : d.loanType === 'io'
        ? (p.prinAdj > 0 ? 'IO Principal Repayment' : 'IO Interest Payment')
        : (p.closed ? 'Full Repayment' : 'Partial Payment');
    e.push({ id: 'p' + p.id, date: p.date, dir: 'in', type: sub, borrowerId: p.borrowerId, borrowerName: bName(p.borrowerId),
      ref: p.ref || d.ref || '', amount: p.amount, fee: 0, gst: 0, adv: 0,
      intAdj: p.intAdj, prinAdj: p.prinAdj, outAfter: p.outAfter, rem: p.rem || '' });
  });
  e = e.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : (a.dir === 'out' ? -1 : 1)));
  if (borrowerId) e = e.filter((x) => x.borrowerId === borrowerId);
  if (from) e = e.filter((x) => x.date >= from);
  if (to) e = e.filter((x) => x.date <= to);
  if (type === 'out' || type === 'in') e = e.filter((x) => x.dir === type);
  return e;
}

/* ---- per-borrower MIS summary (auto-generated) ---- */
function borrowerSummary(store, bid, asOf = td()) {
  const b = store.borrowers.find((x) => x.id === bid);
  if (!b) return null;
  const dds = store.drawdowns.filter((d) => d.borrowerId === bid);
  const pays = store.payments.filter((p) => p.borrowerId === bid);
  const open = dds.filter((d) => d.status !== 'Repaid');
  const outstanding = open.reduce((s, d) => s + (+d.outPrin || 0), 0);
  let accruedOpen = 0, overdueDays = 0, overdueAmount = 0;
  open.forEach((d) => {
    if (d.loanType === 'io') accruedOpen += ioNetDue(d, b, asOf, pays);
    else {
      const a = poAccrued(d, b, asOf);
      accruedOpen += a.total;
      if (a.odD > 0) { overdueDays = Math.max(overdueDays, a.odD); overdueAmount += (+d.outPrin || 0); }
    }
  });
  const advCollected = dds.reduce((s, d) => s + (+d.adv || 0), 0);
  const feeCollected = dds.reduce((s, d) => s + (+d.fee || 0), 0);
  const gstCollected = dds.reduce((s, d) => s + (+d.gstAmt || 0), 0);
  const intCollected = pays.reduce((s, p) => s + (+p.intAdj || 0), 0);
  const principalRepaid = pays.reduce((s, p) => s + (+p.prinAdj || 0), 0);
  const limit = currentLimit(store, bid);
  const lastActivity = [...dds.map((d) => d.bankDebit), ...pays.map((p) => p.date)].sort().pop() || null;
  return {
    borrowerId: bid, name: b.name, slug: b.slug, biz: b.biz, loanType: b.loanType, rate: b.rate,
    tenure: b.tenure, tenureUnit: b.tenureUnit, sanctionDate: b.sanctionDate, isSample: !!b.isSample, asOf,
    product: b.product || null, vcs: b.vcs || [], stopDrawdowns: !!b.stopDrawdowns, status: b.status,
    limit, baseLimit: money(b.limit), limitIncreases: money(limit - (+b.limit || 0)),
    drawn: money(dds.reduce((s, d) => s + (+d.poAmt || 0), 0)),
    disbursedNet: money(dds.reduce((s, d) => s + (+d.disbursed || 0), 0)),
    outstanding: money(outstanding), available: money(Math.max(0, limit - outstanding)),
    utilPct: limit > 0 ? +(outstanding / limit * 100).toFixed(1) : 0,
    advCollected: money(advCollected), feeCollected: money(feeCollected), gstCollected: money(gstCollected),
    intCollected: money(intCollected), principalRepaid: money(principalRepaid),
    interestEarned: money(advCollected + intCollected),
    incomeBooked: money(advCollected + intCollected + feeCollected),
    accruedOpen: money(accruedOpen), overdueDays, overdueAmount: money(overdueAmount),
    activeDrawdowns: open.length, totalDrawdowns: dds.length, totalPayments: pays.length,
    lastActivity,
    irr: calcIRR(borrowerCashFlows(store, bid)),
    renewal: renewalStatus(store, bid)
  };
}

/* ---- portfolio-level rollup (dashboard) ---- */
function portfolio(store, asOf = td()) {
  const sums = store.borrowers.map((b) => borrowerSummary(store, b.id, asOf));
  const sum = (k) => money(sums.reduce((s, x) => s + (x[k] || 0), 0));
  const sanctioned = money(store.borrowers.reduce((s, b) => s + currentLimit(store, b.id), 0));
  const outstanding = sum('outstanding');
  return {
    borrowers: store.borrowers.length,
    sanctioned, outstanding,
    available: money(Math.max(0, sanctioned - outstanding)),
    utilPct: sanctioned > 0 ? +(outstanding / sanctioned * 100).toFixed(1) : 0,
    drawn: sum('drawn'),
    disbursedNet: sum('disbursedNet'),
    interestEarned: sum('interestEarned'),
    feeCollected: sum('feeCollected'),
    gstCollected: sum('gstCollected'),
    incomeBooked: sum('incomeBooked'),
    accruedOpen: sum('accruedOpen'),
    overdueAmount: sum('overdueAmount'),
    activeDrawdowns: store.drawdowns.filter((d) => d.status !== 'Repaid').length,
    totalDrawdowns: store.drawdowns.length,
    asOf,
    byBorrower: sums.sort((a, b) => b.outstanding - a.outstanding)
  };
}

/* ---- monthly disbursed / collected series for the dashboard chart ---- */
function monthlySeries(store, months = 6) {
  const keys = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(d.toISOString().slice(0, 7));
  }
  const blank = () => keys.reduce((m, k) => (m[k] = 0, m), {});
  const out = blank(), inn = blank(), interest = blank();
  store.drawdowns.forEach((d) => { const k = String(d.bankDebit).slice(0, 7); if (k in out) out[k] += +d.poAmt || 0; });
  store.payments.forEach((p) => {
    const k = String(p.date).slice(0, 7);
    if (k in inn) { inn[k] += +p.amount || 0; interest[k] += +p.intAdj || 0; }
  });
  return keys.map((k) => ({
    month: k,
    label: new Date(k + '-01').toLocaleString('en-IN', { month: 'short' }),
    disbursed: money(out[k]), collected: money(inn[k]), interest: money(interest[k])
  }));
}

/* ---- ageing buckets across all open drawdowns ---- */
function ageing(store, asOf = td()) {
  const buckets = [
    { key: 'current', label: 'Within tenure', amount: 0, count: 0 },
    { key: '1-30', label: '1–30 days overdue', amount: 0, count: 0 },
    { key: '31-60', label: '31–60 days overdue', amount: 0, count: 0 },
    { key: '61-90', label: '61–90 days overdue', amount: 0, count: 0 },
    { key: '90+', label: '90+ days overdue', amount: 0, count: 0 }
  ];
  store.drawdowns.filter((d) => d.status !== 'Repaid').forEach((d) => {
    const b = store.borrowers.find((x) => x.id === d.borrowerId);
    if (!b) return;
    const odD = d.loanType === 'io' ? 0 : poAccrued(d, b, asOf).odD;
    const i = odD <= 0 ? 0 : odD <= 30 ? 1 : odD <= 60 ? 2 : odD <= 90 ? 3 : 4;
    buckets[i].amount = money(buckets[i].amount + (+d.outPrin || 0));
    buckets[i].count += 1;
  });
  return buckets;
}

module.exports = {
  money, dr, td, di, addYearISO, addDaysISO, tenureDays, dueDate, advance, feeCalc, computeDrawdown,
  poAccrued, ioAccrued, ioCollected, ioNetDue, accruedFor, allocatePayment, replayDrawdown, decorateDrawdown,
  smaBucket, SMA_KEYS, settlement,
  currentLimit, renewalStatus, calcIRR, borrowerCashFlows,
  buildLedger, borrowerSummary, portfolio, monthlySeries, ageing
};
