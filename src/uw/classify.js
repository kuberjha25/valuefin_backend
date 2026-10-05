'use strict';
/* ============================================================================
   Document classification suggestions (spec §4).

   Deliberately conservative keyword matching on the file name and the first
   pages of text. A suggestion is only ever a suggestion: it is stored with
   classified_by = 'system' and classification_confirmed = 0, and nothing that
   depends on classification (checklist coverage, period checks) counts it
   until an analyst confirms or corrects it.
   ========================================================================== */

const RULES = [
  { type: 'bank_statement', all: [/statement of account|account statement|bank statement/i], any: [/opening balance|closing balance|withdrawal|deposit/i] },
  { type: 'gst_return', any: [/\bGSTR-?\s?(1|3B|9|9C|2A|2B)\b/i] },
  { type: 'gst_certificate', any: [/GST\s*REG-?06|registration certificate.*goods and services tax/i] },
  { type: 'audited_financials', any: [/independent auditor'?s'? report/i] },
  { type: 'itr', any: [/income tax return|\bITR-?[1-7]\b|acknowledgement number/i] },
  { type: 'coi', any: [/certificate of incorporation/i] },
  { type: 'moa_aoa', any: [/memorandum of association|articles of association/i] },
  { type: 'shareholding', any: [/shareholding pattern/i] },
  { type: 'udyam', any: [/udyam registration/i] },
  { type: 'purchase_order', any: [/\bpurchase order\b/i] },
  { type: 'receivables_ageing', all: [/ageing|aging/i, /receivable|debtor/i] },
  { type: 'payables_ageing', all: [/ageing|aging/i, /payable|creditor/i] },
  { type: 'stock_statement', any: [/stock statement/i] },
  { type: 'loan_statement', any: [/loan account statement|repayment schedule|sanction letter/i] },
  { type: 'debt_profile', any: [/debt profile|debt schedule|existing borrowings/i] },
  { type: 'forecast', any: [/projected|projection|forecast/i] }
];

function suggest({ filename = '', text = '' }) {
  const hay = String(filename).replace(/[_\-.]+/g, ' ') + '\n' + String(text).slice(0, 20000);
  for (const r of RULES) {
    const allOk = (r.all || []).every((re) => re.test(hay));
    const anyOk = !r.any || r.any.some((re) => re.test(hay));
    if (allOk && anyOk && (r.all || r.any)) return { docType: r.type };
  }
  return { docType: 'unclassified' };
}

/* Names compared for the entity check: lower-case, punctuation stripped and
   the usual company-suffix spellings folded together. */
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bprivate\b/g, 'pvt').replace(/\blimited\b/g, 'ltd')
    .replace(/\bp\.?\s*ltd\b/g, 'pvt ltd')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function entityMatch(entityName, party) {
  if (!entityName || !String(entityName).trim()) return 'unknown';
  const target = normName(entityName);
  const names = [party.legalName, ...(party.aliases || [])].map(normName);
  return names.includes(target) ? 'match' : 'mismatch';
}

module.exports = { suggest, normName, entityMatch };
