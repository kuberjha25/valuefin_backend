'use strict';
/* ============================================================================
   Underwriting reference data. Idempotent — safe on every boot.

   What is seeded, and why it is not "inferred credit policy":
   * Products: the two products this desk already runs (PO, interest-only).
   * Checklist: the onboarding list the business already uses (checklist.js),
     with the period requirements it states (3 years, 6 months).
   * Field codes: statement line items (definitions, not thresholds).
   * Formulas / reconciliations: a DRAFT Credit Logic Book template — the
     spec's own catalogue (§5). Every one is a draft: nothing runs until two
     people approve it.
   * Policy rules: DRAFT shells with NO threshold. The credit owner supplies
     every threshold (§9); a rule without one cannot be approved.
   * Public sources: the reference points listed in the spec, all manual,
     automated use not permitted until checked (§7, "Reference points").
   ========================================================================== */
const { q } = require('../db/pool');
const { CHECKLIST_ITEMS } = require('../checklist');

const SYSTEM = 'system (seed)';

const PRODUCTS = [['po', 'PO financing'], ['io', 'Interest-only working capital']];

/* existing onboarding checklist key → classification + period rule */
const CHECKLIST_MAP = {
  coi: ['coi'], companyPan: ['company_pan'], directorList: ['director_list'], directorIdProof: ['director_kyc'],
  shareholding: ['shareholding'], moaAoa: ['moa_aoa'], cancelledCheque: ['cancelled_cheque'], udyam: ['udyam'],
  gstCert: ['gst_certificate'],
  auditedBalanceSheet: ['audited_financials', 'annual', 3, 1],
  itr: ['itr', 'annual', 3, 0],
  plMis: ['pl_mis'], cashFlow: ['cash_flow'], debtProfile: ['debt_profile'],
  bankStatements: ['bank_statement', 'monthly', 6, 0],
  forecast: ['forecast']
};

const FIELDS = [
  // income statement — period figures
  ['revenue_from_operations', 'Revenue from operations', 'money', 'flow', 'income'],
  ['other_income', 'Other income', 'money', 'flow', 'income'],
  ['cost_of_materials', 'Cost of materials / purchases', 'money', 'flow', 'income'],
  ['gross_profit', 'Gross profit', 'money', 'flow', 'income'],
  ['employee_expense', 'Employee benefit expense', 'money', 'flow', 'income'],
  ['ebitda', 'EBITDA', 'money', 'flow', 'income'],
  ['depreciation', 'Depreciation and amortisation', 'money', 'flow', 'income'],
  ['finance_costs', 'Finance costs (interest)', 'money', 'flow', 'income'],
  ['pbt', 'Profit before tax', 'money', 'flow', 'income'],
  ['tax_expense', 'Tax expense', 'money', 'flow', 'income'],
  ['pat', 'Profit after tax', 'money', 'flow', 'income'],
  ['operating_cash_flow', 'Net cash from operating activities', 'money', 'flow', 'cash'],
  ['capex', 'Capital expenditure', 'money', 'flow', 'cash'],
  ['debt_service_paid', 'Debt service paid (principal + interest)', 'money', 'flow', 'debt'],
  ['gst_turnover', 'GST return turnover (taxable value)', 'money', 'flow', 'tax'],
  // balance sheet — as-at figures
  ['total_assets', 'Total assets', 'money', 'stock', 'balance_sheet'],
  ['total_equity_and_liabilities', 'Total equity and liabilities', 'money', 'stock', 'balance_sheet'],
  ['net_worth', 'Net worth (total equity)', 'money', 'stock', 'balance_sheet'],
  ['total_debt', 'Total borrowings', 'money', 'stock', 'debt'],
  ['short_term_debt', 'Short-term borrowings', 'money', 'stock', 'debt'],
  ['long_term_debt', 'Long-term borrowings', 'money', 'stock', 'debt'],
  ['current_assets', 'Total current assets', 'money', 'stock', 'balance_sheet'],
  ['current_liabilities', 'Total current liabilities', 'money', 'stock', 'balance_sheet'],
  ['cash_and_bank', 'Cash and bank balances', 'money', 'stock', 'balance_sheet'],
  ['trade_receivables', 'Trade receivables', 'money', 'stock', 'working_capital'],
  ['inventory', 'Inventories', 'money', 'stock', 'working_capital'],
  ['trade_payables', 'Trade payables', 'money', 'stock', 'working_capital'],
  ['receivables_ageing_total', 'Receivables ageing — total', 'money', 'stock', 'working_capital'],
  ['receivables_0_30', 'Receivables ageing — 0–30 days', 'money', 'stock', 'working_capital'],
  ['receivables_31_60', 'Receivables ageing — 31–60 days', 'money', 'stock', 'working_capital'],
  ['receivables_61_90', 'Receivables ageing — 61–90 days', 'money', 'stock', 'working_capital'],
  ['receivables_over_90', 'Receivables ageing — over 90 days', 'money', 'stock', 'working_capital'],
  // purchase order and identity facts — recorded, not used by formulas
  ['po_value', 'Purchase order value', 'money', 'none', 'po'],
  ['po_cost_to_fulfil', 'Purchase order cost to fulfil', 'money', 'none', 'po'],
  ['po_buyer', 'Purchase order buyer', 'text', 'none', 'po'],
  ['po_date', 'Purchase order date', 'date', 'none', 'po'],
  ['po_payment_terms_days', 'Purchase order payment terms (days)', 'number', 'none', 'po'],
  ['incorporation_date', 'Date of incorporation', 'date', 'none', 'identity']
];

const T = (field, sign = 1, offset = 0) => ({ field, sign, offset });
const TEMPLATE_NOTE = 'DRAFT Credit Logic Book template (spec §5). ValueFin must confirm numerator, denominator, period, sign, units and missing-value treatment before approval.';
const FORMULAS = [
  ['revenue_growth', 'Revenue growth', { numerator: [T('revenue_from_operations'), T('revenue_from_operations', -1, -1)], denominator: [T('revenue_from_operations', 1, -1)], multiplier: '100', format: 'percent', basis: 'same', denominatorMustBePositive: true }],
  ['gross_margin', 'Gross margin', { numerator: [T('gross_profit')], denominator: [T('revenue_from_operations')], multiplier: '100', format: 'percent', basis: 'same', denominatorMustBePositive: true }],
  ['ebitda_margin', 'EBITDA margin', { numerator: [T('ebitda')], denominator: [T('revenue_from_operations')], multiplier: '100', format: 'percent', basis: 'same', denominatorMustBePositive: true }],
  ['pat_margin', 'PAT margin', { numerator: [T('pat')], denominator: [T('revenue_from_operations')], multiplier: '100', format: 'percent', basis: 'same', denominatorMustBePositive: true }],
  ['debt_to_equity', 'Debt to equity', { numerator: [T('total_debt')], denominator: [T('net_worth')], multiplier: '1', format: 'ratio', basis: 'same', denominatorMustBePositive: true }],
  ['current_ratio', 'Current ratio', { numerator: [T('current_assets')], denominator: [T('current_liabilities')], multiplier: '1', format: 'ratio', basis: 'same', denominatorMustBePositive: true }],
  ['interest_coverage', 'Interest coverage (EBITDA / finance costs)', { numerator: [T('ebitda')], denominator: [T('finance_costs')], multiplier: '1', format: 'ratio', basis: 'same', denominatorMustBePositive: true }],
  ['dscr', 'Debt service coverage (EBITDA / debt service)', { numerator: [T('ebitda')], denominator: [T('debt_service_paid')], multiplier: '1', format: 'ratio', basis: 'same', denominatorMustBePositive: true }],
  ['receivable_days', 'Receivable days', { numerator: [T('trade_receivables')], denominator: [T('revenue_from_operations')], multiplier: '365', format: 'days', basis: 'same', periodMonths: 12, denominatorMustBePositive: true }],
  ['payable_days', 'Payable days', { numerator: [T('trade_payables')], denominator: [T('cost_of_materials')], multiplier: '365', format: 'days', basis: 'same', periodMonths: 12, denominatorMustBePositive: true }],
  ['inventory_days', 'Inventory days', { numerator: [T('inventory')], denominator: [T('cost_of_materials')], multiplier: '365', format: 'days', basis: 'same', periodMonths: 12, denominatorMustBePositive: true }]
];

const S = (field, sign = 1) => ({ field, sign });
const RECONS = [
  ['bs_tie', 'Balance sheet ties (assets = equity + liabilities)', 'integrity', { left: { terms: [S('total_assets')], basis: null }, right: { terms: [S('total_equity_and_liabilities')], basis: null }, toleranceMode: 'both' }],
  ['revenue_audited_vs_gst', 'Audited revenue vs GST return turnover', 'revenue', { left: { terms: [S('revenue_from_operations')], basis: 'audited' }, right: { terms: [S('gst_turnover')], basis: 'tax_return' }, toleranceMode: 'both' },
    'Like periods only. GST turnover is the taxable value excluding tax; explain exempt supplies, advances and non-operating income.'],
  ['revenue_audited_vs_mis', 'Audited revenue vs management MIS', 'revenue', { left: { terms: [S('revenue_from_operations')], basis: 'audited' }, right: { terms: [S('revenue_from_operations')], basis: 'management' }, toleranceMode: 'both' }],
  ['debt_audited_vs_schedule', 'Audited borrowings vs debt schedule (same date)', 'debt', { left: { terms: [S('total_debt')], basis: 'audited' }, right: { terms: [S('total_debt')], basis: 'borrower_declared' }, toleranceMode: 'both' },
    'A registered charge is not proof of current outstanding (spec §5).'],
  ['receivables_bs_vs_ageing', 'Balance-sheet receivables vs ageing total', 'working_capital', { left: { terms: [S('trade_receivables')], basis: null }, right: { terms: [S('receivables_ageing_total')], basis: null }, toleranceMode: 'both' }],
  ['ageing_buckets_total', 'Ageing buckets add up to the ageing total', 'integrity', { left: { terms: [S('receivables_0_30'), S('receivables_31_60'), S('receivables_61_90'), S('receivables_over_90')], basis: null }, right: { terms: [S('receivables_ageing_total')], basis: null }, toleranceMode: 'both' }]
];

const RULES = [
  ['prohibited_sector', 'Policy-prohibited sector', 'hard_stop', 'case.sector', 'in', false],
  ['critical_public_event', 'Verified critical public event', 'hard_stop', 'public.critical_count', 'gt', true],
  ['incomplete_public_verification', 'Incomplete public verification', 'committee_exception', 'public.unresolved_count', 'gt', false],
  ['unexplained_reconciliation', 'Unexplained reconciliation differences', 'committee_exception', 'recon.outside_tolerance_unexplained', 'gt', false]
];

const SOURCE_FALLBACK = 'Analyst searches the site manually and attaches a snapshot or a written attestation. If the site cannot be used, record "failed" or "manual review required" — never "clear".';
const SOURCES = [
  ['GST public taxpayer profile', 'India', 'https://tutorial.gst.gov.in/userguide/taxpayersdashboard/Search_Taxpayer_manual.htm', 'GSTIN, PAN', 'Spec reference is the GST portal user manual for "Search Taxpayer". Confirm the live search page and its terms before use.'],
  ['IBBI public announcements', 'India', 'https://ibbi.gov.in/public-announcement', 'Company name, CIN', 'Insolvency / liquidation announcements.'],
  ['eCourts party search', 'India', 'https://services.ecourts.gov.in/ecourtindia_v6/', 'Party name', 'Official court case search. CAPTCHA protected — manual only.'],
  ['CPPP procurement awards', 'India', 'https://eprocure.gov.in/eprocure/app', 'Company name', 'Relevant where the borrower relies on public procurement.'],
  ['Corporate master data (MCA)', 'India', '', 'CIN, company name', 'Spec: "if accessible under site conditions". Add the URL after checking the site\'s current access conditions.'],
  ['Credit rating rationales', 'India', '', 'Company name', 'Published rationales of the rating agencies, where the borrower is rated.']
];

async function seedUnderwriting() {
  const report = [];

  for (const [k, label] of PRODUCTS) await q('INSERT IGNORE INTO uw_products (product_key, label) VALUES (?, ?)', [k, label]);

  const [{ n: ci }] = await q('SELECT COUNT(*) AS n FROM uw_checklist_items');
  if (!ci) {
    let order = 0;
    for (const it of CHECKLIST_ITEMS) {
      const [docType, rule = 'none', periods = null, auditedOnly = 0] = CHECKLIST_MAP[it.key] || ['other'];
      await q(`INSERT INTO uw_checklist_items (product, item_key, label, doc_type, mandatory, period_rule, periods_required, audited_only, sort_order)
               VALUES (NULL,?,?,?,1,?,?,?,?)`, [it.key, it.label, docType, rule, periods, auditedOnly, (order += 10)]);
    }
    report.push('uw checklist: ' + CHECKLIST_ITEMS.length + ' items');
  }

  for (const [code, label, type, kind, cat] of FIELDS) {
    await q('INSERT IGNORE INTO uw_field_codes (code, label, value_type, period_kind, category) VALUES (?,?,?,?,?)', [code, label, type, kind, cat]);
  }

  const [{ n: fo }] = await q('SELECT COUNT(*) AS n FROM uw_formulas');
  if (!fo) {
    for (const [code, label, def] of FORMULAS) {
      await q('INSERT INTO uw_formulas (code, version, label, definition, notes, status, created_by) VALUES (?,1,?,?,?,\'draft\',?)',
        [code, label, JSON.stringify(Object.assign({ missingTreatment: 'not_computable' }, def)), TEMPLATE_NOTE, SYSTEM]);
    }
    report.push('uw formulas: ' + FORMULAS.length + ' drafts');
  }

  const [{ n: rd }] = await q('SELECT COUNT(*) AS n FROM uw_recon_defs');
  if (!rd) {
    for (const [code, label, area, def, note] of RECONS) {
      await q('INSERT INTO uw_recon_defs (code, version, label, control_area, definition, notes, status, created_by) VALUES (?,1,?,?,?,?,\'draft\',?)',
        [code, label, area, JSON.stringify(def), [note, 'DRAFT — tolerance to be set by the credit owner.'].filter(Boolean).join(' '), SYSTEM]);
    }
    report.push('uw reconciliations: ' + RECONS.length + ' drafts');
  }

  const [{ n: ru }] = await q('SELECT COUNT(*) AS n FROM uw_rules');
  if (!ru) {
    for (const [code, label, cls, metric, op, overridable] of RULES) {
      await q(`INSERT INTO uw_rules (code, version, label, rule_class, metric, operator, threshold, overridable, test_cases, notes, status, created_by)
               VALUES (?,1,?,?,?,?,NULL,?,?,?,'draft',?)`,
        [code, label, cls, metric, op, overridable ? 1 : 0, JSON.stringify([]), 'DRAFT — threshold to be supplied by the credit owner (spec §9). Add test cases before submitting for approval.', SYSTEM]);
    }
    report.push('uw rules: ' + RULES.length + ' drafts without thresholds');
  }

  const [{ n: so }] = await q('SELECT COUNT(*) AS n FROM uw_sources');
  if (!so) {
    for (const [name, jur, url, ids, notes] of SOURCES) {
      await q(`INSERT INTO uw_sources (name, jurisdiction, url, search_identifiers, access_method, automated_use_permitted, owner, fallback, notes)
               VALUES (?,?,?,?,'manual',0,'',?,?)`, [name, jur, url, ids, SOURCE_FALLBACK, notes]);
    }
    report.push('uw public sources: ' + SOURCES.length);
  }
  return report;
}

module.exports = { seedUnderwriting };
