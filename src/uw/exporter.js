'use strict';
/* ============================================================================
   Credit memo export — a self-contained, printable HTML page rendered from a
   snapshot payload (or from live data shaped the same way). Every value is
   escaped; citation tokens become numbered source notes.
   ========================================================================== */
const money = require('./money');
const { MEMO_SECTIONS } = require('./vocab');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (paise) => {
  if (paise == null) return '—';
  const s = money.paiseToRupeeString(paise);
  const neg = s.startsWith('-');
  const [w, f] = s.replace('-', '').split('.');
  const grouped = w.length > 3 ? w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + w.slice(-3) : w;
  return (neg ? '-' : '') + '₹' + grouped + '.' + f;
};
const trimNum = (s, dp = 2) => {
  if (s == null) return '—';
  const n = Number(s);
  return isFinite(n) ? n.toFixed(dp) : String(s);
};

function render(p, { snapshotMeta = null, draft = false } = {}) {
  const c = p.case, party = p.party;
  const notes = [];
  const cite = (body) => esc(body).replace(/\[\[([^\[\]]{1,120})\]\]/g, (_, tok) => {
    let i = notes.indexOf(tok);
    if (i < 0) { notes.push(tok); i = notes.length - 1; }
    return '<sup class="cite">[' + (i + 1) + ']</sup>';
  }).replace(/\n/g, '<br>');
  const factLabel = new Map((p.facts || []).map((f) => [f.id, f]));
  const describe = (tok) => {
    const [type, a, b, d] = tok.split(':');
    if (type === 'fact') {
      const f = factLabel.get(Number(a));
      if (!f) return 'Fact #' + a;
      const val = f.valueType === 'money' ? rupees(f.amountPaise) : (f.valueNum != null ? f.valueNum : f.valueText);
      return 'Fact #' + f.id + ' — ' + (f.fieldLabel || f.fieldCode) + ' ' + val + ' (' + f.basis + (f.periodEnd ? ', ' + (f.periodStart ? f.periodStart + ' to ' : 'as at ') + f.periodEnd : '') + ')'
        + (f.sourceName ? ' · source: ' + f.sourceName + (f.sourcePage ? ' p.' + f.sourcePage : '') + (f.sourceCell ? ' ' + f.sourceCell : '') : '');
    }
    if (type === 'calc') return 'Calculation ' + a + ' · ' + d + ' · period ending ' + b;
    if (type === 'recon') return 'Reconciliation ' + a + ' · ' + b + (d ? ' · ' + d : '');
    if (type === 'doc') {
      const v = (p.documents || []).find((x) => x.id === Number(a));
      return 'Document ' + (v ? v.originalName + ' (v' + v.version + ', SHA-256 ' + String(v.sha256 || '').slice(0, 12) + '…)' : '#' + a) + (b ? ' ' + b : '');
    }
    if (type === 'txn') return 'Bank transaction #' + a;
    if (type === 'check') return 'Public check #' + a;
    return tok;
  };

  const sections = MEMO_SECTIONS.map(([key, label]) => {
    const body = (p.memo && p.memo.sections && p.memo.sections[key]) || '';
    return '<h2>' + esc(label) + '</h2>' + (body.trim() ? '<p>' + cite(body) + '</p>' : '<p class="muted">Not written.</p>');
  }).join('');

  const fmtCalc = (r) => r.status === 'computed' ? trimNum(r.value, 2) : 'not computable';
  const calcRows = (p.calculations || []).map((r) => '<tr><td>' + esc(r.formulaCode) + ' v' + r.formulaVersion + '</td><td>' + esc((r.periodStart ? r.periodStart + ' – ' : 'as at ') + r.periodEnd) + '</td><td>' + esc(r.basis) + '</td><td class="r">' + esc(fmtCalc(r)) + (r.provisional ? ' (provisional)' : '') + '</td><td>' + esc(r.rationale) + '</td></tr>').join('');
  const reconRows = (p.reconciliations || []).map((r) => '<tr><td>' + esc(r.defCode) + '</td><td>' + esc(r.comparableBasis) + '</td><td class="r">' + esc(rupees(r.leftPaise)) + '</td><td class="r">' + esc(rupees(r.rightPaise)) + '</td><td class="r">' + esc(rupees(r.gapPaise)) + (r.gapPct != null ? ' (' + trimNum(r.gapPct, 2) + '%)' : '') + '</td><td>' + esc(r.outcome.replace(/_/g, ' ')) + '</td><td>' + esc(r.resolution === 'none' ? '' : r.resolution + ': ' + (r.explanation || '')) + '</td></tr>').join('');
  const ruleRows = (p.rules || []).map((r) => '<tr><td>' + esc(r.ruleClass.replace(/_/g, ' ')) + '</td><td>' + esc(r.ruleCode) + ' v' + r.ruleVersion + '</td><td>' + esc(r.outcome.replace(/_/g, ' ')) + '</td><td>' + esc(r.detail) + '</td></tr>').join('');
  const dispRows = (p.dispositions || []).map((d) => '<tr><td>' + esc(d.kind.replace('_', ' ')) + '</td><td>' + esc(d.ruleCode) + '</td><td>' + esc(d.reviewerName) + '</td><td>' + esc(d.rationale) + '</td></tr>').join('');
  const checkRows = (p.publicChecks || []).map((x) => '<tr><td>' + esc(x.sourceName) + '</td><td>' + esc(x.searchTerms) + '</td><td>' + esc(x.status.replace(/_/g, ' ')) + (x.critical ? ' — CRITICAL' : '') + '</td><td>' + esc(x.searchedAt || '') + '</td><td>' + esc(x.resultTitle || x.analystNote || '') + '</td></tr>').join('');
  const qRows = (p.questions || []).map((x) => '<tr><td>' + esc(x.status) + '</td><td>' + esc(x.question) + '</td><td>' + esc(x.response || '') + '</td></tr>').join('');
  const t = c.terms || {};
  const table = (head, rows) => rows ? '<table><thead><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted">None.</p>';

  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + esc(c.caseCode) + ' credit memo</title><style>'
    + 'body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff;max-width:960px;margin:24px auto;padding:0 16px}'
    + 'h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px}'
    + 'table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12.5px}th,td{border:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top}th{background:#f4f4f6}.r{text-align:right;white-space:nowrap}'
    + '.muted{color:#777}.banner{padding:8px 12px;border:1px solid #c9a227;background:#fff8e1;margin:12px 0}.cite{color:#3b4cca;font-size:10px}'
    + '.kv{display:grid;grid-template-columns:200px 1fr;gap:2px 12px}ol.notes{font-size:12px;color:#333}@media print{.banner{break-inside:avoid}}'
    + '</style></head><body>'
    + '<h1>Credit memo — ' + esc(party.legalName) + '</h1>'
    + '<p class="muted">' + esc(c.caseCode) + ' · revision ' + c.revision + ' · status ' + esc(c.status.replace(/_/g, ' ')) + '</p>'
    + (draft ? '<div class="banner">DRAFT — rendered from live data, not from a frozen snapshot. Figures may change.</div>'
      : '<div class="banner">Frozen snapshot #' + esc(snapshotMeta.id) + ' (revision ' + snapshotMeta.revision + ') · SHA-256 ' + esc(snapshotMeta.sha256) + (snapshotMeta.verified === false ? ' · <b>INTEGRITY CHECK FAILED</b>' : ' · integrity verified') + '</div>')
    + '<div class="kv"><span>Borrower</span><span>' + esc(party.legalName) + ' (' + esc([party.cin, party.pan, party.gstin].filter(Boolean).join(' · ') || 'no identifiers') + ')</span>'
    + '<span>Product</span><span>' + esc(c.product) + '</span><span>Requested</span><span>' + esc(rupees(c.requestedPaise)) + ' for ' + c.tenorDays + ' days</span>'
    + '<span>Proposed</span><span>' + (t.amountPaise != null ? esc(rupees(t.amountPaise)) + ' for ' + t.tenorDays + ' days' + (t.ratePct ? ' at ' + esc(t.ratePct) + '% p.a.' : '') : 'not recorded') + '</span>'
    + '<span>Purpose</span><span>' + esc(c.purpose) + '</span><span>Repayment source</span><span>' + esc(c.repaymentSource) + '</span></div>'
    + '<div class="banner">This memo records an analyst recommendation and review. It is not a disbursement instruction.</div>'
    + sections
    + '<h2>Policy rules</h2>' + table(['Class', 'Rule', 'Outcome', 'Detail'], ruleRows)
    + (dispRows ? '<h2>Overrides and exception reviews</h2>' + table(['Kind', 'Rule', 'Reviewer', 'Rationale'], dispRows) : '')
    + '<h2>Calculations</h2>' + table(['Measure', 'Period', 'Basis', 'Value', 'Note'], calcRows)
    + '<h2>Reconciliations</h2>' + table(['Check', 'Basis / period', 'Left', 'Right', 'Gap', 'Outcome', 'Resolution'], reconRows)
    + '<h2>Public checks</h2>' + table(['Source', 'Search', 'Outcome', 'Searched', 'Result / note'], checkRows)
    + '<h2>Borrower questions</h2>' + table(['Status', 'Question', 'Response'], qRows)
    + (notes.length ? '<h2>Sources cited</h2><ol class="notes">' + notes.map((n) => '<li>' + esc(describe(n)) + '</li>').join('') + '</ol>' : '')
    + '</body></html>';
}

module.exports = { render, esc };
