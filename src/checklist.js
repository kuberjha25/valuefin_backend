'use strict';
/* ============================================================================
   The fixed set of onboarding documents every borrower is expected to file,
   grouped the way the business asked for them. A document can be tagged with
   one of these keys (documents.checklist_key) so a borrower's progress against
   the list can be read back — see GET /api/borrowers/:id/checklist.
   ========================================================================== */

const CHECKLIST_GROUPS = [
  {
    key: 'company',
    title: 'Company profile and profiles of all directors',
    items: [
      { key: 'coi', label: 'Certificate of Incorporation' },
      { key: 'companyPan', label: 'Company PAN Card' },
      { key: 'directorList', label: 'List of Directors' },
      { key: 'directorIdProof', label: 'PAN and Aadhaar of Directors' },
      { key: 'shareholding', label: 'Shareholding Pattern' },
      { key: 'moaAoa', label: 'MOA and AOA' },
      { key: 'cancelledCheque', label: 'Cancelled Cheque' },
      { key: 'udyam', label: 'Udyam Aadhaar' },
      { key: 'gstCert', label: 'GST Certificate' }
    ]
  },
  {
    key: 'financials',
    title: 'Financial documents',
    items: [
      { key: 'auditedBalanceSheet', label: 'Audited Balance Sheet for the last 3 years' },
      { key: 'itr', label: 'ITR for the last 3 years' },
      { key: 'plMis', label: 'P&L statement and MIS (month wise)' },
      { key: 'cashFlow', label: 'Cash Flow Statement (month wise)' },
      { key: 'debtProfile', label: 'Debt Profile – details of current borrowings' },
      { key: 'bankStatements', label: 'Bank Statements for the last 6 months' },
      { key: 'forecast', label: 'Forecasted Financials for the next 3 years' }
    ]
  }
];

const CHECKLIST_ITEMS = CHECKLIST_GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.title })));
const CHECKLIST_KEYS = CHECKLIST_ITEMS.map((it) => it.key);
const CHECKLIST_LABEL = Object.fromEntries(CHECKLIST_ITEMS.map((it) => [it.key, it.label]));

module.exports = { CHECKLIST_GROUPS, CHECKLIST_ITEMS, CHECKLIST_KEYS, CHECKLIST_LABEL };
