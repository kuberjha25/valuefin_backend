'use strict';
/* The fixed vocabularies of the underwriting module. Routes validate input
   against these lists, and GET /api/uw/meta hands the same lists to the UI so
   the two can never disagree. */

const DOC_TYPES = [
  ['unclassified', 'Unclassified'],
  ['coi', 'Certificate of Incorporation'],
  ['company_pan', 'Company PAN'],
  ['director_list', 'List of directors'],
  ['director_kyc', 'Director PAN / Aadhaar'],
  ['shareholding', 'Shareholding pattern'],
  ['moa_aoa', 'MOA and AOA'],
  ['cancelled_cheque', 'Cancelled cheque'],
  ['udyam', 'Udyam registration'],
  ['gst_certificate', 'GST registration certificate'],
  ['audited_financials', 'Audited financial statements'],
  ['unaudited_financials', 'Unaudited / provisional financials'],
  ['itr', 'Income tax return'],
  ['pl_mis', 'P&L / MIS (monthly)'],
  ['cash_flow', 'Cash flow statement'],
  ['debt_profile', 'Debt profile / schedule'],
  ['bank_statement', 'Bank statement'],
  ['forecast', 'Forecast financials'],
  ['gst_return', 'GST return'],
  ['receivables_ageing', 'Receivables ageing'],
  ['payables_ageing', 'Payables ageing'],
  ['stock_statement', 'Stock statement'],
  ['loan_statement', 'Loan statement / sanction letter'],
  ['purchase_order', 'Purchase order'],
  ['borrower_response', 'Borrower response'],
  ['public_check_snapshot', 'Public check snapshot'],
  ['other', 'Other']
];
const DOC_TYPE_KEYS = DOC_TYPES.map(([k]) => k);

const AUDIT_STATUSES = ['audited', 'unaudited', 'provisional', 'not_applicable', 'unknown'];

/* Basis of a fact — what kind of source vouches for it. */
const BASES = ['audited', 'unaudited', 'provisional', 'management', 'tax_return', 'bank', 'borrower_declared', 'other'];

const VALUE_TYPES = ['money', 'number', 'percent', 'text', 'date'];
const PERIOD_KINDS = ['flow', 'stock', 'none'];

/* Bank classification (spec §6). Receipts use the spec's six classes; debits
   get the matching outflow classes. `is_return` is a separate flag. */
const CREDIT_CATEGORIES = ['operating', 'financing', 'owner_group', 'internal_transfer', 'tax_refund', 'unknown'];
const DEBIT_CATEGORIES = ['operating_payment', 'debt_service', 'owner_group', 'internal_transfer', 'tax_payment', 'unknown'];
const BANK_CATEGORIES = Array.from(new Set([...CREDIT_CATEGORIES, ...DEBIT_CATEGORIES]));

const CASE_STATUSES = ['open', 'submitted', 'recommended', 'sent_back', 'approved', 'approved_modified', 'declined'];
const EDITABLE_STATUSES = ['open', 'sent_back'];
const IN_REVIEW_STATUSES = ['submitted', 'recommended'];
const DECIDED_STATUSES = ['approved', 'approved_modified', 'declined'];

const CHECK_STATUSES = ['pending', 'match_found', 'no_match', 'failed', 'manual_review_required'];
const MATCH_CONFIDENCE = ['exact', 'probable', 'possible', 'none'];
const SUPPORT_STATES = ['supported', 'partially_supported', 'unsupported', 'contradicted', 'unverified'];

const RULE_CLASSES = ['hard_stop', 'committee_exception', 'warning'];
const OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'in', 'not_in'];
const CONTROL_AREAS = ['revenue', 'debt', 'cash_bank', 'working_capital', 'po', 'integrity', 'other'];

/* Metrics a policy rule may test. Formula and fact metrics carry a basis
   selector after "@": a named basis, or "latest" (latest period, and only if
   exactly one basis exists for it — otherwise the rule is not evaluable). */
const CASE_METRICS = [
  ['case.sector', 'text', 'Sector of the case'],
  ['case.product', 'text', 'Product'],
  ['case.requested_amount', 'number', 'Requested amount (₹)'],
  ['case.tenor_days', 'number', 'Requested tenor (days)'],
  ['case.vintage_years', 'number', 'Borrower vintage (years)'],
  ['public.critical_count', 'number', 'Public checks marked as a verified critical event'],
  ['public.unresolved_count', 'number', 'Public checks failed, pending or needing manual review'],
  ['recon.outside_tolerance_unexplained', 'number', 'Reconciliations outside tolerance and not explained'],
  ['docs.missing_mandatory_count', 'number', 'Mandatory checklist items not satisfied'],
  ['bank.unknown_credit_share_pct', 'number', 'Unknown receipts as % of all receipts (excl. duplicates)'],
  ['bank.financing_credit_share_pct', 'number', 'Financing receipts as % of all receipts'],
  ['bank.top_counterparty_share_pct', 'number', 'Largest tagged counterparty as % of operating receipts'],
  ['bank.return_count', 'number', 'Returned items visible in statements']
];

const MEMO_SECTIONS = [
  ['summary', 'Summary and recommendation'],
  ['borrower', 'Borrower, group and identity'],
  ['facility', 'Facility, purpose and repayment source'],
  ['financials', 'Financial analysis'],
  ['bank', 'Bank analysis'],
  ['reconciliation', 'Reconciliations and differences'],
  ['public_checks', 'Public checks and claims'],
  ['risks', 'Risks, mitigants and policy exceptions'],
  ['terms', 'Proposed terms and conditions']
];

module.exports = {
  DOC_TYPES, DOC_TYPE_KEYS, AUDIT_STATUSES, BASES, VALUE_TYPES, PERIOD_KINDS,
  CREDIT_CATEGORIES, DEBIT_CATEGORIES, BANK_CATEGORIES,
  CASE_STATUSES, EDITABLE_STATUSES, IN_REVIEW_STATUSES, DECIDED_STATUSES,
  CHECK_STATUSES, MATCH_CONFIDENCE, SUPPORT_STATES, RULE_CLASSES, OPERATORS, CONTROL_AREAS,
  CASE_METRICS, MEMO_SECTIONS
};
