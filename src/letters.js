'use strict';
/* Generated origination paperwork — the CAM, the sanction letter and the draft
   facility agreement. Each is built from the application's own record (the
   policy snapshot and the sanction terms), so a letter can never state terms the
   facility does not carry. They open as printable pages; "download" saves the
   same HTML. */
const policy = require('./policy');
const { bad } = require('./http');

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl = (v) => esc(v).replace(/\r?\n/g, '<br>');
const inr = (n) => policy.inr(n);
const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return isNaN(d) ? esc(String(iso).slice(0, 10)) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
};
const whenTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? esc(iso) : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const CSS = `
  *{box-sizing:border-box}
  body{font:14px/1.55 Georgia,'Times New Roman',serif;color:#1b1b1f;margin:0;background:#f4f4f6}
  .page{max-width:820px;margin:24px auto;background:#fff;padding:48px 56px;box-shadow:0 1px 8px rgba(0,0,0,.12)}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 8px;border-bottom:1px solid #bbb;padding-bottom:3px;text-transform:uppercase;letter-spacing:.06em}
  .meta{color:#555;font-size:12px}
  table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}
  th,td{border:1px solid #c9c9cf;padding:6px 9px;text-align:left;vertical-align:top}
  th{background:#f0f0f4;font-weight:600} td.r,th.r{text-align:right}
  .kv td:first-child{width:34%;background:#fafafc;font-weight:600}
  .tag{display:inline-block;border:1px solid #888;border-radius:3px;padding:0 6px;font-size:11px}
  .ok{color:#136f3a}.bad{color:#a01a1a}.warn{color:#9a6200}
  .banner{border:2px solid #a01a1a;color:#a01a1a;padding:6px 10px;font-weight:700;letter-spacing:.08em;text-align:center;margin-bottom:18px}
  .sig{display:flex;gap:40px;margin-top:56px}.sig div{flex:1;border-top:1px solid #333;padding-top:4px;font-size:12px}
  ol li{margin:5px 0}
  .bar{position:sticky;top:0;background:#222;color:#fff;padding:8px 16px;font:13px system-ui;display:flex;gap:12px;align-items:center}
  .bar button{font:13px system-ui;padding:4px 12px;cursor:pointer}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:0;max-width:none}.bar{display:none}}
`;

const frame = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>
<div class="bar"><b>${esc(title)}</b><button onclick="window.print()">Print / save as PDF</button></div>
<div class="page">${body}</div></body></html>`;

const kv = (rows) => '<table class="kv">' + rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') + '</table>';

/* ---------------- CAM ---------------- */
function cam(app) {
  const rc = app.policyCheck;
  if (!rc) throw bad('Run the policy check first — the CAM embeds its snapshot.');
  const c = app.cam || {};
  const sections = [
    ['Personal discussion (PD) notes', c.pdNotes], ['Business & management assessment', c.bizMgmt],
    ['Repayment tools / source of repayment', c.repaymentTools], ['Financial assessment', c.finAssessment],
    ['Key risks & mitigation', c.risks], ['Conditions precedent', c.conditionsPrecedent]
  ];
  const dev = app.deviation;
  const decision = c.status === 'approved' ? `<span class="ok">Approved</span> by ${esc(c.decidedBy)} on ${whenTime(c.decidedAt)}`
    : c.status === 'rejected' ? `<span class="bad">Declined</span> by ${esc(c.decidedBy)} on ${whenTime(c.decidedAt)}`
      : c.status === 'pending' ? '<span class="warn">Awaiting the Director</span>' : 'Draft — not yet submitted';

  return frame('CAM — ' + app.appCode, `
    <h1>Credit Appraisal Memorandum</h1>
    <p class="meta">${esc(app.appCode)} · ${esc(app.legalName)} · Credit Policy v${esc(rc.policyVersion)} · policy run ${whenTime(rc.ts)}</p>

    <h2>Proposal</h2>
    ${kv([
      ['Applicant', esc(app.legalName) + ' (' + esc(app.entityType || '—') + ')'],
      ['Sector', esc(app.sector || '—')], ['Product', esc(app.productName)],
      ['Requested', inr(app.requestedAmount)], ['Tenure', esc(app.tenureValue + ' ' + app.tenureUnit) + ' (' + app.tenorDays + ' days)'],
      ['Promoter', esc(app.promoterName || '—') + (app.promoterMobile ? ' · ' + esc(app.promoterMobile) : '')],
      ['PAN / GSTIN', esc([app.companyPan, app.gstin].filter(Boolean).join(' · ') || '—')],
      ['Backing funds', esc((app.vcs || []).join(', ') || '—')],
      ['Purpose', nl(app.purpose || '—')], ['Repayment source', nl(app.repaymentSource || '—')]
    ])}

    <h2>Credit snapshot</h2>
    ${kv([
      ['Policy verdict', esc(String(rc.verdict).replace(/_/g, ' '))], ['Policy-eligible amount', inr(rc.eligible)],
      ['Binding cap', esc(rc.binding)],
      ['Rate', rc.rate.final + '% p.a. (' + rc.rate.floor + '% floor ' + (rc.rate.qAdj >= 0 ? '+' : '') + rc.rate.qAdj + '% quality ' +
        (rc.rate.sAdj >= 0 ? '+' : '') + rc.rate.sAdj + '% structure)'],
      ['Internal grade', esc(rc.score.grade) + ' — ' + rc.score.finalScore + ' / 100 · indicative PD ' + esc(rc.score.pd)],
      ['Approval authority (§8)', esc(rc.authority)]
    ])}
    <p>${nl(rc.reason)}</p>

    <h2>Sizing caps</h2>
    <table><tr><th>Cap</th><th class="r">Value</th></tr>
    ${rc.caps.map((x) => `<tr><td>${esc(x.label)}${x.label === rc.binding ? ' <span class="tag">binding</span>' : ''}</td><td class="r">${inr(x.value)}</td></tr>`).join('')}
    <tr><th>Eligible (lowest cap, rounded down to ₹1 L)</th><th class="r">${inr(rc.eligible)}</th></tr></table>

    <h2>Gates and §7 caps</h2>
    <table><tr><th>Gate</th><th>Required</th><th>Actual</th><th>Result</th></tr>
    ${rc.gates.map((g) => `<tr><td>${esc(g.label)}</td><td>${esc(g.required)}</td><td>${esc(g.actual)}</td>
      <td class="${g.pass ? 'ok' : 'bad'}">${g.pass ? 'Pass' : (g.hard ? 'Hard stop' : 'Fail')}</td></tr>`).join('')}</table>

    <h2>Scorecard</h2>
    <table><tr><th>Component</th><th class="r">Weight</th><th class="r">Score</th><th class="r">Weighted</th></tr>
    ${rc.score.breakdown.map((b) => `<tr><td>${esc(b.label)}</td><td class="r">${b.weight}%</td><td class="r">${b.score}</td><td class="r">${(b.score * b.weight / 100).toFixed(1)}</td></tr>`).join('')}
    <tr><th colspan="3">Final score / grade</th><th class="r">${rc.score.finalScore} · ${esc(rc.score.grade)}</th></tr></table>

    ${dev ? `<h2>§9 deviation ${dev.n} of 2</h2>${kv([
      ['Gate(s) and reason', nl(dev.reason)], ['Compensating controls', nl(dev.compensating)],
      ['Status', esc(dev.status) + (dev.decidedBy ? ' — ' + esc(dev.decidedBy) : '')],
      ['Pricing', dev.status === 'approved' ? (dev.pricingBump ? '+' + dev.pricingBump + '% on the sanction rate' : 'no bump') : '—'],
      ['Director comment', nl(dev.checkerComment || '—')]
    ])}` : ''}

    ${sections.map(([t, v]) => `<h2>${esc(t)}</h2><p>${v && String(v).trim() ? nl(v) : '<i>Not recorded.</i>'}</p>`).join('')}

    <h2>Decision</h2>
    <p>${decision}${c.comment ? '<br>' + nl(c.comment) : ''}</p>
    <div class="sig"><div>Credit Officer</div><div>Director</div><div>Director / Committee</div></div>
  `);
}

/* ---------------- sanction letter ---------------- */
function sanctionLetter(app) {
  const s = app.sanction;
  if (!s) throw bad('This application has not been sanctioned yet.');
  const cps = String((app.cam && app.cam.conditionsPrecedent) || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const interestOnly = app.product === 'bullet';

  return frame('Sanction letter — ' + app.appCode, `
    <h1>Sanction Letter</h1>
    <p class="meta">Ref: ${esc(app.appCode)} · Date: ${when(s.sanctionDate)}</p>
    <p>To,<br><b>${esc(app.legalName)}</b><br>Attention: ${esc(app.promoterName || 'The Directors')}</p>
    <p><b>Sub: Sanction of a ${esc(app.productName)} facility of ${inr(s.amount)}</b></p>
    <p>We refer to your application ${esc(app.appCode)} and the discussions that followed. We are pleased to advise that the
    facility below has been sanctioned, subject to the terms and conditions in this letter and the facility agreement.</p>

    <h2>Terms of the facility</h2>
    ${kv([
      ['Borrower', esc(app.legalName)], ['Facility', esc(app.productName) + (interestOnly ? ' (interest-only, bullet principal)' : ' (drawn in tranches)')],
      ['Sanctioned limit', inr(s.amount)],
      ['Rate of interest', s.rate + '% per annum' + (s.pricingBump ? ' (includes a §9 risk premium of ' + s.pricingBump + '%)' : '') + ', computed daily on a 365-day year on the outstanding principal'],
      ['Tenor per tranche', s.tenorDays + ' days from the date each tranche is disbursed'],
      ['Processing fee', s.pfPct + '% of each tranche, plus GST at ' + s.gstPct + '%, deducted at disbursal'],
      ['Advance interest', 'May be collected upfront at disbursal for an agreed opening window and set off against the interest due'],
      ['Penal interest', 'A further ' + s.penalPct + '% per annum, over and above the rate, on principal outstanding beyond the tenor'],
      ['Application of receipts', 'Interest (including penal interest and any amount carried forward) first, then principal'],
      ['Purpose', nl(app.purpose || '—')], ['Source of repayment', nl(app.repaymentSource || '—')],
      ['Sanction date', when(s.sanctionDate)], ['Validity of the facility', 'Until ' + when(s.expiry) + ', subject to annual review']
    ])}

    <h2>Conditions precedent to disbursement</h2>
    ${cps.length ? '<ol>' + cps.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ol>' : '<p>As set out in the facility agreement.</p>'}

    <h2>General conditions</h2>
    <ol>
      <li>Each drawdown is subject to availability within the sanctioned limit and to our satisfaction that no event of default or drawdown stop is in force.</li>
      <li>The borrower will furnish monthly management information and permit site visits as we reasonably require.</li>
      <li>We may reduce, suspend or cancel any undrawn part of the facility if the borrower's conduct or credit standing deteriorates.</li>
      <li>This sanction lapses if the facility agreement is not executed within thirty days of the date of this letter.</li>
    </ol>
    <p>Please sign and return a copy of this letter in token of your acceptance.</p>
    <p>Sanctioned by ${esc(s.sanctionedBy)} · Credit Policy v${esc(s.policyVersion || '1.0')}</p>
    <div class="sig"><div>For Valuefin — Authorised signatory</div><div>Accepted — for ${esc(app.legalName)}</div></div>
  `);
}

/* ---------------- draft facility agreement ---------------- */
function agreement(app) {
  const s = app.sanction;
  if (!s) throw bad('This application has not been sanctioned yet.');
  const clause = (n, title, text) => `<h2>${n}. ${esc(title)}</h2>${text}`;

  return frame('Draft agreement — ' + app.appCode, `
    <div class="banner">DRAFT — FOR LEGAL REVIEW BEFORE EXECUTION</div>
    <h1>Facility Agreement</h1>
    <p class="meta">Ref ${esc(app.appCode)} · dated ${when(s.sanctionDate)}</p>
    <p>This Agreement is made between <b>Valuefin</b> (the “Lender”) and <b>${esc(app.legalName)}</b>
    ${app.companyPan ? '(PAN ' + esc(app.companyPan) + ')' : ''} (the “Borrower”).</p>

    ${clause(1, 'The facility', `<p>The Lender makes available to the Borrower a ${esc(app.productName)} facility with a limit of
      <b>${inr(s.amount)}</b> (the “Limit”), to be drawn in tranches, each for a tenor of <b>${s.tenorDays} days</b>, for the purpose of
      ${esc(app.purpose || 'the Borrower’s working capital')}. The facility is available until ${when(s.expiry)}.</p>`)}
    ${clause(2, 'Interest', `<p>Interest accrues daily on the outstanding principal of each tranche at <b>${s.rate}% per annum</b> on a 365-day year,
      counting both the disbursal date and the date of payment. Interest for an opening advance window may be collected at disbursal.</p>`)}
    ${clause(3, 'Fees', `<p>A processing fee of <b>${s.pfPct}%</b> of each tranche, together with GST at ${s.gstPct}%, is payable on and deducted from each
      disbursal. The principal outstanding is the full tranche amount, not the net amount paid.</p>`)}
    ${clause(4, 'Repayment', `<p>Each tranche is repayable in full on the last day of its tenor. Every receipt is applied first to interest
      (including penal interest and any shortfall carried forward) and then to principal. The Borrower may repay early; interest runs to the date of repayment.</p>`)}
    ${clause(5, 'Penal interest', `<p>On any principal outstanding after its tenor, interest accrues at the rate in clause 2 <b>plus ${s.penalPct}% per annum</b> until paid.</p>`)}
    ${clause(6, 'Drawdown', `<p>A drawdown request is subject to (a) availability within the Limit, (b) no event of default, and (c) no drawdown stop imposed by the Lender.
      The Lender may refuse a drawdown while any MIS due under clause 8 is outstanding.</p>`)}
    ${clause(7, 'Representations', `<p>The Borrower represents that it is duly incorporated and validly existing, that the information it has given the Lender is true and
      complete, that no wilful default or insolvency proceeding is pending against it or its promoters, and that the facility is used only for the stated purpose.</p>`)}
    ${clause(8, 'Undertakings', `<p>The Borrower shall furnish monthly management information, permit site visits and inspection of books on reasonable notice, inform the Lender
      promptly of any material adverse development, and not create any security over the receivables financed under this facility.</p>`)}
    ${clause(9, 'Events of default', `<p>Non-payment on the due date; breach of any representation or undertaking; insolvency or the commencement of any recovery or winding-up proceeding;
      or any event that, in the Lender’s reasonable opinion, materially impairs the Borrower’s ability to repay. On an event of default the Lender may cancel the undrawn Limit and
      demand immediate repayment of all amounts outstanding.</p>`)}
    ${clause(10, 'Governing law', `<p>This Agreement is governed by the laws of India. The courts at the Lender’s registered office have exclusive jurisdiction.</p>`)}

    <div class="sig"><div>For Valuefin — Authorised signatory</div><div>For ${esc(app.legalName)} — Authorised signatory</div></div>
  `);
}

async function render(kind, app) {
  if (kind === 'cam') return cam(app);
  if (kind === 'sanction') return sanctionLetter(app);
  if (kind === 'agreement') return agreement(app);
  throw bad('Unknown document.');
}

module.exports = { render };
