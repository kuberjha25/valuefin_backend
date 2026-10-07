'use strict';
/* ============================================================================
   Credit policy — pure functions, no I/O.

   Everything here is the arithmetic written up on the Guide screen: the three
   products and their floors, the sizing caps (§4A–C), the rate build (§5), the
   scorecard, the gates and §7 concentration caps, the §8 approval matrix and the
   §9 deviation rules. Every function takes plain objects and returns plain
   objects, so a policy run can be reproduced from the snapshot stored on the
   application.
   ========================================================================== */

const money = (n) => Math.round((+n || 0) * 100) / 100;
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const LAKH = 100000;
const CRORE = 10000000;

/* Indian digit grouping, used in the sentences the policy writes. */
function inr(n) {
  const x = Math.round(num(n));
  const neg = x < 0 ? '-' : '';
  let s = String(Math.abs(x));
  if (s.length > 3) s = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  return '₹' + neg + s;
}
function inrShort(n) {
  const x = num(n), a = Math.abs(x);
  if (a >= CRORE) return '₹' + +(x / CRORE).toFixed(2) + ' Cr';
  if (a >= LAKH) return '₹' + +(x / LAKH).toFixed(2) + ' L';
  return inr(x);
}

/* ---------------- catalogue: written policy, not editable from the app ---------------- */
const PRODUCTS = {
  quick_cash: {
    key: 'quick_cash', name: 'Quick Cash', floor: 16, rateRange: [16, 19], min: 25 * LAKH, max: CRORE,
    tenor: '30–120 days', tenorDays: [30, 120]
  },
  rocket_fuel: {
    key: 'rocket_fuel', name: 'Rocket Fuel', floor: 18, rateRange: [18, 22], min: 10 * LAKH, max: 75 * LAKH,
    tenor: '3–6 months', tenorDays: [90, 186]
  },
  bullet: {
    key: 'bullet', name: 'Bullet', floor: 20, rateRange: [20, 24], min: 10 * LAKH, max: 50 * LAKH,
    tenor: '3–12 months', tenorDays: [90, 366]
  }
};
const PRODUCT_KEYS = Object.keys(PRODUCTS);

const SECTORS = [
  'D2C / consumer brands', 'E-commerce & marketplaces', 'FMCG & distribution', 'SaaS & software',
  'Fintech', 'Healthtech & wellness', 'Edtech', 'Logistics & supply chain', 'Manufacturing',
  'Agri & food processing', 'Retail', 'Services', 'Other'
];
const NO_GO = ['gambling & betting', 'crypto & virtual assets', 'tobacco', 'arms & ammunition', 'wilful default'];

/* §8 — read against total group exposure after the loan. */
const APPROVAL_MATRIX = [
  { max: 25 * LAKH, authority: 'Credit Officer + 1 Director' },
  { max: 50 * LAKH, authority: 'Credit Officer + 2 Directors' },
  { max: CRORE, authority: 'Credit Committee' },
  { max: null, authority: 'Board of Directors' }
];

/* §9 — compensating controls a deviation may offer. */
const DEVIATION_CONTROLS = [
  'Personal guarantee of the promoters',
  'Post-dated cheques for the full tenor',
  'Escrow / collection account with a lien in our favour',
  'Direct assignment of buyer payments to us',
  'Additional collateral or a fixed deposit lien',
  'Corporate guarantee from an investor or group company',
  'Shorter tenor with a reduced ticket',
  'Enhanced monitoring — monthly MIS and fortnightly site visits'
];

const DEFAULT_POLICY = {
  policyVersion: '1.0',
  penalDefault: 24,
  gstPct: 18,
  nof: 0,
  vcCapWarnPct: 15,
  vcCapMaxPct: 20,
  vcCapMinBook: 2 * CRORE
};

/* The scorecard: component labels are fixed, weights are a Director setting. */
const SCORE_COMPONENTS = {
  quick_cash: [
    { key: 'cibil', label: 'Promoter CIBIL', weight: 25 },
    { key: 'opYears', label: 'Operating history', weight: 15 },
    { key: 'receivable', label: 'Receivable quality', weight: 20 },
    { key: 'counterparty', label: 'Counterparty strength', weight: 20 },
    { key: 'conduct', label: 'Banking conduct', weight: 20 }
  ],
  rocket_fuel: [
    { key: 'cibil', label: 'Promoter CIBIL', weight: 15 },
    { key: 'opYears', label: 'Operating history', weight: 10 },
    { key: 'round', label: 'Funding round', weight: 20 },
    { key: 'investor', label: 'Lead investor tier', weight: 15 },
    { key: 'runway', label: 'Runway', weight: 20 },
    { key: 'revenue', label: 'Monthly revenue', weight: 20 }
  ],
  bullet: [
    { key: 'cibil', label: 'Promoter CIBIL', weight: 25 },
    { key: 'opYears', label: 'Operating history', weight: 15 },
    { key: 'primaryExit', label: 'Primary exit', weight: 25 },
    { key: 'backupExit', label: 'Backup exit', weight: 15 },
    { key: 'surplus', label: 'Cash surplus cover', weight: 20 }
  ]
};
const defaultWeights = () => JSON.parse(JSON.stringify(SCORE_COMPONENTS));

/* Mandatory document rows a new application starts with. */
const DEFAULT_CHECKLISTS = {
  common: [
    { key: 'coi', label: 'Certificate of Incorporation', mandatory: true },
    { key: 'pan', label: 'Company PAN card', mandatory: true },
    { key: 'gst', label: 'GST registration certificate', mandatory: true },
    { key: 'kyc', label: 'KYC of directors and promoters (PAN + Aadhaar)', mandatory: true },
    { key: 'bank', label: 'Bank statements — last 6 months', mandatory: true },
    { key: 'cheque', label: 'Cancelled cheque', mandatory: false }
  ],
  quick_cash: [
    { key: 'paper', label: 'Purchase orders / invoices backing the facility', mandatory: true },
    { key: 'anchor', label: 'Anchor buyer acceptance or confirmation', mandatory: false }
  ],
  rocket_fuel: [
    { key: 'round', label: 'Latest funding round — term sheet or SHA summary', mandatory: true },
    { key: 'captable', label: 'Current cap table', mandatory: true },
    { key: 'mis', label: 'Monthly MIS — last 6 months', mandatory: true }
  ],
  bullet: [
    { key: 'exit', label: 'Exit evidence — term sheet or commitment letter', mandatory: true },
    { key: 'cashflow', label: 'Projected cash-flow statement', mandatory: true }
  ]
};
const defaultChecklists = () => JSON.parse(JSON.stringify(DEFAULT_CHECKLISTS));

const FUNDING_REASONS = ['Inventory purchase', 'General working capital', 'Growth spend (marketing / expansion)', 'Bridge to next round'];

/* What the Settings screen reads, in one object. */
function catalogue() {
  return {
    products: PRODUCT_KEYS.map((k) => ({ ...PRODUCTS[k] })),
    sectors: SECTORS.slice(),
    noGo: NO_GO.slice(),
    approvalMatrix: APPROVAL_MATRIX.map((r) => ({ ...r })),
    deviationControls: DEVIATION_CONTROLS.slice(),
    fundingReasons: FUNDING_REASONS.slice()
  };
}

/* ---------------- tenure ---------------- */
function tenorDaysOf(value, unit) {
  const v = num(value) || 90;
  return unit === 'months' ? Math.round(v * 30.4375) : Math.round(v);
}

/* ---------------- sizing — §4A / §4B / §4C ----------------
   The lowest cap binds; the eligible amount is that cap rounded DOWN to the
   nearest lakh. */
function sizing(product, x) {
  const rate = num(x.rate) / 100;
  const tenorDays = num(x.tenorDays) || 90;
  const caps = [];
  const add = (label, value) => caps.push({ label, value: Math.max(0, Math.round(num(value))) });

  if (product === 'quick_cash') {
    const po = num(x.poTotal), inv = num(x.invTotal);
    add('LTV tiers — PO at 75%, invoice / bill / settlement at 90% (§4A)', po * 0.75 + inv * 0.9);
    const coverage = x.anchorListed ? 1.1 : 1.2;
    add('Coverage — paper ÷ (' + coverage.toFixed(2) + '× principal + interest) (§4A)',
      (po + inv) / (coverage * (1 + rate * tenorDays / 365)));
    add('Product ceiling (§4A)', PRODUCTS.quick_cash.max);
  } else if (product === 'rocket_fuel') {
    const months = tenorDays / 30.4375;
    add('Revenue — 3× average monthly revenue (§4B)', 3 * num(x.avgMonthlyRevenue));
    add('Round — 15% of the last institutional round (§4B)', 0.15 * num(x.roundSize));
    add('Runway protection — burn × (runway − 3 months) after repayment (§4B)',
      num(x.monthlyBurn) * Math.max(0, num(x.runwayMonths) - 3) / (1 + rate * months / 12));
    add('Leverage — round size less existing external debt (§4B)', Math.max(0, num(x.roundSize) - num(x.existingDebt)));
    add('Product ceiling (§4B)', PRODUCTS.rocket_fuel.max);
  } else if (product === 'bullet') {
    add('Serviceability — interest ≤ 40% of monthly surplus (§4C)',
      rate > 0 ? (0.4 * num(x.netCashSurplus)) / (rate / 12) : 0);
    add('Product ceiling (§4C)', PRODUCTS.bullet.max);
  } else {
    throw Object.assign(new Error('Unknown product "' + product + '".'), { status: 400 });
  }

  const binding = caps.reduce((lo, c) => (c.value < lo.value ? c : lo), caps[0]);
  const eligible = Math.max(0, Math.floor(binding.value / LAKH) * LAKH);
  return { caps, binding: binding.label, eligible };
}

/* ---------------- rate build — §5 ---------------- */
function buildRate(product, r) {
  const floor = PRODUCTS[product].floor;
  const qAdj = num(r.qAdj), sAdj = num(r.sAdj);
  return {
    floor, qAdj, sAdj, final: +(floor + qAdj + sAdj).toFixed(2),
    belowFloor: floor + qAdj + sAdj < floor - 1e-9
  };
}

/* ---------------- scorecard ---------------- */
function gradeOf(score) { return score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D'; }
const PD = { A: '0.5–1%', B: '1–2.5%', C: '2.5–5%', D: 'over 5%' };

function componentScore(product, key, e, ctx) {
  switch (key) {
    case 'cibil': return clamp((num(e.cibil) - 650) / 200 * 100);
    case 'opYears': return clamp(num(e.opYears) / 5 * 100);
    // Quick Cash
    case 'receivable': return { platform: 90, corporate: 70 }[e.receivableType] || 50;
    case 'counterparty': return e.anchorListed ? 85 : 60;
    case 'conduct': return num(e.bounces12m) > 0 ? 35 : 75;
    // Rocket Fuel
    case 'round': return clamp(num(e.roundSize) / (10 * CRORE) * 60 + Math.max(0, 18 - num(e.roundAgeMonths)) / 18 * 40);
    case 'investor': {
      const tier = ctx.investorTier;
      return tier === '1' ? 90 : tier === '2' ? 70 : 50;
    }
    case 'runway': return clamp(num(e.runwayMonths) / 18 * 100);
    case 'revenue': return clamp(num(e.avgMonthlyRevenue) / (50 * LAKH) * 100);
    // Bullet
    case 'primaryExit': return !String(e.exitPrimary || '').trim() ? 0 : ({ confirmed: 90, likely: 65, weak: 40 }[e.exitPrimaryQuality || 'likely'] || 65);
    case 'backupExit': return String(e.exitBackup || '').trim() ? 70 : 0;
    case 'surplus': {
      const surplus = num(e.netCashSurplus);
      if (surplus <= 0) return 0;
      const monthlyInterest = num(ctx.requested) * num(ctx.rate) / 100 / 12;
      return clamp(100 - (monthlyInterest / (0.4 * surplus)) * 60);
    }
    default: return 0;
  }
}

function score(product, weights, e, ctx) {
  const rows = (weights && weights[product]) || SCORE_COMPONENTS[product];
  const breakdown = rows.map((c) => ({
    key: c.key, label: c.label, weight: num(c.weight),
    score: Math.round(componentScore(product, c.key, e, ctx) * 10) / 10
  }));
  const totalWeight = breakdown.reduce((s, b) => s + b.weight, 0);
  const finalScore = totalWeight > 0
    ? Math.round(breakdown.reduce((s, b) => s + b.score * b.weight, 0) / totalWeight * 10) / 10
    : 0;
  const grade = gradeOf(finalScore);
  return { finalScore, grade, pd: PD[grade], breakdown };
}

/* ---------------- §8 approval authority ---------------- */
function authorityFor(exposureAfter, belowFloor) {
  if (belowFloor) return 'Board of Directors';
  const row = APPROVAL_MATRIX.find((r) => r.max == null || exposureAfter <= r.max);
  return row.authority;
}

/* ---------------- the policy run ----------------
   app   : { product, legalName, sector, requestedAmount, tenorDays, vcs[], companyPan }
   e     : the gate inputs (eligibility)
   rate  : { qAdj, sAdj, qComment, sComment, tenorComment }
   recv  : [{ kind, value }]
   book  : { liveBook, bulletOutstanding, vcExposure:{vc:amount}, groupExposure }
   policy: DEFAULT_POLICY-shaped settings
   ctx   : { weights, investorTier }                                           */
function runPolicy({ app, e, rate: rateIn, recv, book, policy, weights, investorTier }) {
  const product = app.product;
  const P = PRODUCTS[product];
  const requested = num(app.requestedAmount);
  const tenorDays = num(app.tenorDays) || 90;
  const rate = buildRate(product, rateIn || {});
  e = e || {};

  /* ---- sizing ---- */
  const paperKinds = (recv || []).reduce((t, p) => {
    const v = num(p.value);
    if (String(p.kind).toLowerCase() === 'po' || String(p.kind).toLowerCase() === 'other') t.po += v; else t.inv += v;
    return t;
  }, { po: 0, inv: 0 });
  const sized = sizing(product, {
    rate: rate.final, tenorDays,
    poTotal: paperKinds.po, invTotal: paperKinds.inv, anchorListed: !!e.anchorListed,
    avgMonthlyRevenue: e.avgMonthlyRevenue, roundSize: e.roundSize, runwayMonths: e.runwayMonths,
    monthlyBurn: e.monthlyBurn, existingDebt: e.existingDebt, netCashSurplus: e.netCashSurplus
  });

  /* ---- gates ---- */
  const gates = [];
  const gate = (label, pass, required, actual, hard = false) => gates.push({ label, pass: !!pass, hard: !!hard, required, actual });
  const sector = String(app.sector || '').trim();

  gate('Sector is not on the no-go list', !NO_GO.includes(sector.toLowerCase()), 'not a no-go sector', sector || 'not set', true);
  gate('No wilful default on record', !e.wilfulDefault, 'none', e.wilfulDefault ? 'wilful default recorded' : 'none', true);
  gate('Sector identified', !!sector, 'recorded', sector || 'not set');
  gate('Promoter CIBIL at or above 700', e.cibil != null && e.cibil !== '' && num(e.cibil) >= 700, '≥ 700',
    e.cibil != null && e.cibil !== '' ? String(num(e.cibil)) : 'not provided');
  gate('Operating history of at least one year', e.opYears != null && e.opYears !== '' && num(e.opYears) >= 1, '≥ 1 year',
    e.opYears != null && e.opYears !== '' ? num(e.opYears) + ' year(s)' : 'not provided');
  gate('Tenor within the product band', tenorDays >= P.tenorDays[0] && tenorDays <= P.tenorDays[1], P.tenor, tenorDays + ' days');

  if (product === 'quick_cash') {
    const paper = paperKinds.po + paperKinds.inv;
    gate('Receivable paper tagged (§4A)', paper > 0, 'at least one receivable', paper > 0 ? inrShort(paper) + ' tagged' : 'none tagged');
    gate('No more than two instrument bounces in 12 months', num(e.bounces12m) <= 2, '≤ 2', String(num(e.bounces12m)));
  } else if (product === 'rocket_fuel') {
    gate('Reason for funding stated (§4B)', FUNDING_REASONS.includes(e.fundingReason), 'one of the permitted reasons', e.fundingReason || 'not stated');
    gate('Runway of at least six months', num(e.runwayMonths) >= 6, '≥ 6 months', e.runwayMonths != null && e.runwayMonths !== '' ? num(e.runwayMonths) + ' months' : 'not provided');
    gate('Last round within 18 months', e.roundAgeMonths != null && e.roundAgeMonths !== '' && num(e.roundAgeMonths) <= 18, '≤ 18 months',
      e.roundAgeMonths != null && e.roundAgeMonths !== '' ? num(e.roundAgeMonths) + ' months' : 'not provided');
  } else if (product === 'bullet') {
    const both = !!String(e.exitPrimary || '').trim() && !!String(e.exitBackup || '').trim();
    gate('Primary and backup exit both named (§4C)', both, 'both named',
      both ? 'both named' : (!String(e.exitPrimary || '').trim() ? 'primary exit missing' : 'backup exit missing'), true);
    gate('Exit value covers at least 1.5× the loan (§4C)', num(e.exitAmount) >= 1.5 * requested, '≥ ' + inrShort(1.5 * requested),
      e.exitAmount != null && e.exitAmount !== '' ? inrShort(num(e.exitAmount)) : 'not provided');
    const interest = requested * rate.final / 100 / 12;
    const surplus = num(e.netCashSurplus);
    gate('Monthly interest within 40% of the monthly surplus (§4C)', surplus > 0 && interest <= 0.4 * surplus,
      '≤ ' + inrShort(0.4 * surplus), inrShort(interest));
  }

  /* §7 concentration — non-deviatable, active only once the book is large enough. */
  const liveBook = num(book.liveBook);
  const bookAfter = liveBook + requested;
  const active = liveBook >= num(policy.vcCapMinBook);
  const advisory = ' — advisory, book below ' + inrShort(policy.vcCapMinBook);
  (app.vcs || []).forEach((vc) => {
    const exp = num((book.vcExposure || {})[vc]) + requested;
    const pct = bookAfter > 0 ? exp / bookAfter * 100 : 0;
    const over = pct > num(policy.vcCapWarnPct);
    const hard = pct > num(policy.vcCapMaxPct);
    gate('VC concentration — ' + vc + ' (§7)', !active || !over,
      '≤ ' + policy.vcCapWarnPct + '% of the live book (hard above ' + policy.vcCapMaxPct + '%)',
      pct.toFixed(1) + '%' + (active ? '' : advisory), active && hard);
  });
  const nof = num(policy.nof);
  if (nof > 0) {
    const group = num(book.groupExposure) + requested;
    const cap = 0.05 * nof;
    gate('Single-borrower cap — 5% of Net Owned Funds (§7)', !active || group <= cap, '≤ ' + inrShort(cap),
      inrShort(group) + (active ? '' : advisory), active);
  } else {
    gate('Single-borrower cap — 5% of Net Owned Funds (§7)', true, '≤ 5% of NOF', 'inactive — Net Owned Funds not recorded');
  }
  if (product === 'bullet') {
    const pct = bookAfter > 0 ? (num(book.bulletOutstanding) + requested) / bookAfter * 100 : 0;
    gate('Bullet aggregate — 25% of the live book (§7)', !active || pct <= 25, '≤ 25% of the live book',
      pct.toFixed(1) + '%' + (active ? '' : advisory), active);
  }

  /* ---- grade, authority, verdict ---- */
  const sc = score(product, weights, e, { investorTier, requested, rate: rate.final });
  const loan = sized.eligible > 0 ? Math.min(requested, sized.eligible) : requested;
  const authority = authorityFor(num(book.groupExposure) + loan, rate.belowFloor);

  const hardFails = gates.filter((g) => !g.pass && g.hard);
  const softFails = gates.filter((g) => !g.pass && !g.hard);
  let verdict, reason;
  if (hardFails.length) {
    verdict = 'DECLINE';
    reason = 'Hard stop — ' + hardFails.map((g) => g.label).join('; ') + '. No deviation is possible.';
  } else if (sized.eligible < P.min) {
    verdict = 'DECLINE';
    reason = 'Policy-eligible ' + inr(sized.eligible) + ' is below the ' + P.name + ' minimum of ' + inrShort(P.min) +
      ' (binding cap: ' + sized.binding + ').';
  } else if (softFails.length) {
    verdict = 'DEVIATION_REQUIRED';
    reason = softFails.length + ' gate(s) failed — ' + softFails.map((g) => g.label).join('; ') +
      '. Raise a §9 deviation with at least one compensating control.';
  } else if (sized.eligible < requested) {
    verdict = 'APPROVE_LOWER';
    reason = 'Policy supports ' + inr(sized.eligible) + ' against ' + inr(requested) + ' requested (binding cap: ' + sized.binding + ').';
  } else {
    verdict = 'PASS';
    reason = 'Within policy — every gate passed and ' + inr(requested) + ' sits inside the binding cap (' + sized.binding + ').';
  }

  return {
    verdict, reason, eligible: sized.eligible, caps: sized.caps, binding: sized.binding,
    score: sc, authority, rate: { floor: rate.floor, qAdj: rate.qAdj, sAdj: rate.sAdj, final: rate.final },
    gates, policyVersion: String(policy.policyVersion || '1.0'), ts: new Date().toISOString(),
    inputs: { requested, tenorDays, eligibility: e, rate: rateIn || {}, receivables: paperKinds, book: { ...book } },
    weights: (weights && weights[product]) || SCORE_COMPONENTS[product]
  };
}

/* §9 — a deviation can only be raised against a file whose verdict a
   deviation can actually cure. */
const DEVIATION_MAX = 2;

module.exports = {
  money, num, clamp, inr, inrShort, LAKH, CRORE,
  PRODUCTS, PRODUCT_KEYS, SECTORS, NO_GO, APPROVAL_MATRIX, DEVIATION_CONTROLS, FUNDING_REASONS,
  DEFAULT_POLICY, SCORE_COMPONENTS, DEFAULT_CHECKLISTS, DEVIATION_MAX,
  defaultWeights, defaultChecklists, catalogue, tenorDaysOf,
  sizing, buildRate, score, gradeOf, authorityFor, runPolicy
};
