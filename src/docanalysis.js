'use strict';
/* ============================================================================
   Reading an uploaded PDF.

   The text comes from the document's own text layer (exact, free, a few
   milliseconds). Pages with no text layer are scans; they would need OCR, and no
   OCR service is configured on this server, so a scan is reported as such rather
   than guessed at.

   A bank statement is recognised by its shape, not by a per-bank template: a row
   is a date, a narration and trailing money columns, and which way the money went
   is decided by which way the running balance moved. That is also the
   self-check — if the balances do not chain on at least 90% of rows, the rows
   were misread and the summary says the totals are indicative.
   ========================================================================== */
const { extractPdf } = require('./uw/extract');

const money = (n) => Math.round((+n || 0) * 100) / 100;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const inr = (n) => '₹' + Math.round(+n || 0).toLocaleString('en-IN');

/* ---------------- tokens ---------------- */
function parseDate(tok) {
  let m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(tok);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return valid(y, +m[2], +m[1]);
  }
  m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(tok);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\s/\-.]?([A-Za-z]{3,4})[\s/\-.,]*(\d{2,4})$/.exec(tok);
  if (m && MONTHS[m[2].toLowerCase()]) {
    let y = +m[3]; if (y < 100) y += 2000;
    return valid(y, MONTHS[m[2].toLowerCase()], +m[1]);
  }
  return null;
}
function valid(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return y + '-' + pad(mo) + '-' + pad(d);
}

/* A money token has two decimals: 1,25,000.00 · 5000.00 · (5,000.00) · 5,000.00Cr */
const MONEY = /^\(?-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}\)?(?:CR|DR|Cr|Dr)?$/;
function parseMoney(tok) {
  if (!MONEY.test(tok)) return null;
  const neg = /^\(|^-/.test(tok) || /(DR|Dr)$/.test(tok);
  const n = parseFloat(tok.replace(/[(),\-]|CR|DR|Cr|Dr/g, ''));
  return isFinite(n) ? { value: n, neg, dr: /(DR|Dr)$/.test(tok), cr: /(CR|Cr)$/.test(tok) } : null;
}

/* A date can be one token ("01/04/2026") or three ("01 Apr 2026"). */
function leadingDate(tokens) {
  const one = parseDate(tokens[0]);
  if (one) return { date: one, used: 1 };
  if (tokens.length >= 3) {
    const three = parseDate(tokens[0] + ' ' + tokens[1] + ' ' + tokens[2]);
    if (three) return { date: three, used: 3 };
  }
  return null;
}

/* ---------------- statement rows ---------------- */
const SKIP = /(page\s+\d+\s*(of|\/)\s*\d+|opening balance|closing balance|statement of account|statement summary|brought forward|carried forward|total\s+(debit|credit|withdrawal|deposit)|account (number|no)|ifsc|customer id)/i;

function parseRows(lines) {
  const rows = [];
  let last = null;
  for (const line of lines) {
    const tokens = line.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const lead = leadingDate(tokens);
    if (!lead) {
      // A continuation of the previous narration: short, no money columns, not a header/footer.
      if (last && !SKIP.test(line.text) && !tokens.some((t) => MONEY.test(t)) && line.text.length < 120 && last.cont < 3) {
        last.narration += ' ' + line.text; last.cont++;
      }
      continue;
    }
    let rest = tokens.slice(lead.used);
    // A second date (value date) straight after the first is not narration.
    const second = rest.length ? leadingDate(rest) : null;
    if (second) rest = rest.slice(second.used);

    // Trailing money columns: [debit] [credit] balance — or [amount] balance.
    const money = [];
    let end = rest.length;
    while (end > 0) {
      let tok = rest[end - 1];
      let m = parseMoney(tok);
      // "5,000.00 Cr" with the suffix as its own token
      if (!m && /^(CR|DR|Cr|Dr)$/.test(tok) && end > 1 && parseMoney(rest[end - 2])) {
        m = parseMoney(rest[end - 2] + tok); end--;
      }
      if (!m) break;
      money.unshift(m); end--;
    }
    if (money.length < 2) { last = null; continue; }
    const narration = rest.slice(0, end).join(' ');
    if (SKIP.test(narration) && !narration) { last = null; continue; }

    const balanceTok = money[money.length - 1];
    let amountTok;
    if (money.length >= 3) {
      const a = money[money.length - 3], b = money[money.length - 2];
      amountTok = a.value > 0.004 ? a : b;           // the other column is a printed 0.00
    } else amountTok = money[money.length - 2];
    const balance = balanceTok.neg || balanceTok.dr ? -balanceTok.value : balanceTok.value;
    const row = { date: lead.date, narration: narration.replace(/\s+/g, ' ').trim(), amount: money_(amountTok.value), balance: money_(balance),
      hint: amountTok.cr ? 'credit' : amountTok.dr ? 'debit' : null, cont: 0 };
    rows.push(row);
    last = row;
  }
  return rows;
}
const money_ = (n) => Math.round(n * 100) / 100;

const CREDIT_WORDS = /(\bCR\b|credit|deposit|received|salary|refund|interest paid|inward|by transfer|neft cr|imps cr|upi cr|cash dep)/i;
const DEBIT_WORDS = /(\bDR\b|debit|withdraw|paid|payment|purchase|charges|chq|cheque issued|emi|atm|pos |transfer to|to transfer|outward)/i;

/* Direction from the way the running balance moved; the first row, which has
   nothing before it, falls back to the opening balance, then to its own wording. */
function assignDirections(rows, opening) {
  let verified = 0;
  rows.forEach((r, i) => {
    const prev = i === 0 ? opening : rows[i - 1].balance;
    if (prev != null) {
      const delta = money_(r.balance - prev);
      r.direction = delta >= 0 ? 'credit' : 'debit';
      r.verified = Math.abs(Math.abs(delta) - r.amount) <= 0.05;
    } else {
      r.direction = r.hint || (CREDIT_WORDS.test(r.narration) && !DEBIT_WORDS.test(r.narration) ? 'credit'
        : DEBIT_WORDS.test(r.narration) ? 'debit' : 'debit');
      r.verified = false;
    }
    if (r.verified) verified++;
    delete r.hint; delete r.cont;
  });
  // The first row has no predecessor, so it is verified when the second row chains off it.
  if (rows.length > 1 && !rows[0].verified) {
    const r0 = rows[0], r1 = rows[1];
    if (Math.abs(Math.abs(r1.balance - r0.balance) - r1.amount) <= 0.05) { r0.verified = true; verified++; }
  }
  return verified;
}

/* ---------------- classification of narrations ---------------- */
const RETURNED = /(return(ed)?\b|bounce|dishonou?r|insufficient|\brtn\b|ecs[^a-z]*rtn|nach[^a-z]*rtn|chq\s*ret|cheque\s*return|chargeback)/i;
const EMI = /(\bemi\b|\bnach\b|\becs\b|mandate|loan\s*(repay|instal)|\bloan\b)/i;
const SALARY = /(salary|payroll|\bsal\b)/i;
const CHARGES = /(charges?|\bchg\b|\bfee\b|\bgst\b|\bsms\b|\bamc\b|service tax)/i;

function counterparty(narration) {
  const parts = String(narration).toUpperCase().split(/[\/\-:|@]/).map((p) => p.replace(/[^A-Z &.]/g, ' ').replace(/\s+/g, ' ').trim());
  const skip = /^(UPI|NEFT|IMPS|RTGS|CR|DR|NACH|ECS|CHQ|BY|TO|FROM|TRANSFER|PAYMENT|REF|CLG|ATM|POS|INB|MB|BIL|IFN)$/;
  const clean = parts.map((p) => {
    const w = p.split(' ');
    while (w.length && skip.test(w[0])) w.shift();
    return w.join(' ');
  });
  const best = clean.filter((p) => p.length >= 3 && !skip.test(p)).sort((a, b) => b.length - a.length)[0];
  return (best || 'Unidentified').slice(0, 48);
}

/* ---------------- analysis ---------------- */
function summarise(rows, text) {
  const credits = rows.filter((r) => r.direction === 'credit');
  const debits = rows.filter((r) => r.direction === 'debit');
  const sum = (a) => money(a.reduce((s, r) => s + r.amount, 0));
  const totalCredit = sum(credits), totalDebit = sum(debits);

  const first = rows[0].date, lastD = rows[rows.length - 1].date;
  const monthsCovered = (+lastD.slice(0, 4) - +first.slice(0, 4)) * 12 + (+lastD.slice(5, 7) - +first.slice(5, 7)) + 1;

  const byMonth = {};
  rows.forEach((r) => {
    const k = r.date.slice(0, 7);
    const m = byMonth[k] = byMonth[k] || { month: k, credit: 0, debit: 0, count: 0 };
    if (r.direction === 'credit') m.credit += r.amount; else m.debit += r.amount;
    m.count++;
  });
  const monthly = Object.values(byMonth).sort((a, b) => (a.month < b.month ? -1 : 1)).map((m) => ({
    ...m, credit: money(m.credit), debit: money(m.debit),
    label: new Date(m.month + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  }));

  const balances = rows.map((r) => r.balance);
  const avgBalance = money(balances.reduce((s, b) => s + b, 0) / balances.length);

  const byPayer = {};
  credits.forEach((r) => { const n = counterparty(r.narration); byPayer[n] = (byPayer[n] || 0) + r.amount; });
  const topCredits = Object.entries(byPayer).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, amount]) => ({ name, amount: money(amount), share: totalCredit > 0 ? +(amount / totalCredit * 100).toFixed(1) : 0 }));

  const returned = rows.filter((r) => RETURNED.test(r.narration));
  const flag = (re, dir) => rows.filter((r) => re.test(r.narration) && (!dir || r.direction === dir));
  const emi = flag(EMI, 'debit'), salary = flag(SALARY, 'credit'), charges = flag(CHARGES, 'debit');

  return {
    period: { from: first, to: lastD, monthsCovered },
    openingBalance: money(rows[0].direction === 'credit' ? rows[0].balance - rows[0].amount : rows[0].balance + rows[0].amount),
    closingBalance: rows[rows.length - 1].balance,
    totalCredit, totalDebit, creditCount: credits.length, debitCount: debits.length,
    avgMonthlyCredit: money(totalCredit / monthsCovered), avgMonthlyDebit: money(totalDebit / monthsCovered),
    avgBalance, minBalance: Math.min(...balances), maxBalance: Math.max(...balances),
    monthly, topCredits,
    returns: { count: returned.length, items: returned.slice(0, 25).map((r) => ({ date: r.date, narration: r.narration, amount: r.amount })) },
    emi: { count: emi.length, amount: sum(emi) }, salary: { count: salary.length, amount: sum(salary) },
    charges: { count: charges.length, amount: sum(charges) }
  };
}

/* Where the bank prints its own totals, check the parse against them. */
function reconcile(text, s) {
  const grab = (re) => { const m = re.exec(text); return m ? parseFloat(m[1].replace(/,/g, '')) : null; };
  const pc = grab(/total\s+(?:credits?|deposits?)[^\d\n]{0,30}((?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})/i);
  const pd = grab(/total\s+(?:debits?|withdrawals?)[^\d\n]{0,30}((?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})/i);
  const pb = grab(/closing\s+balance[^\d\n-]{0,30}(-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})/i);
  if (pc == null && pd == null && pb == null) return null;
  const near = (a, b) => Math.abs(a - b) <= 1;
  return {
    creditsMatch: pc == null ? true : near(pc, s.totalCredit),
    debitsMatch: pd == null ? true : near(pd, s.totalDebit),
    closingMatch: pb == null ? true : near(pb, s.closingBalance),
    printed: { credits: pc, debits: pd, closing: pb }
  };
}

function bulletsFor(a, s, verifiedPct) {
  const b = [];
  const fmtD = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  b.push({ tone: 'info', text: 'Statement covers ' + fmtD(s.period.from) + ' to ' + fmtD(s.period.to) + ' — ' + s.period.monthsCovered +
    ' month(s), ' + a.transactionCount + ' transaction(s).' });
  b.push({ tone: 'good', text: 'Average monthly inflow ' + inr(s.avgMonthlyCredit) + '; total credits ' + inr(s.totalCredit) + ' across ' + s.creditCount + ' entries.' });
  b.push({ tone: s.avgMonthlyDebit > s.avgMonthlyCredit ? 'warn' : 'info',
    text: 'Average monthly outflow ' + inr(s.avgMonthlyDebit) + (s.avgMonthlyDebit > s.avgMonthlyCredit ? ' — spending exceeds inflow over the period.' : '.') });
  b.push({ tone: s.minBalance < 0 ? 'bad' : (s.avgBalance < s.avgMonthlyDebit * 0.25 ? 'warn' : 'info'),
    text: 'Average balance ' + inr(s.avgBalance) + ' (low ' + inr(s.minBalance) + ', high ' + inr(s.maxBalance) + ').' +
      (s.minBalance < 0 ? ' The account went overdrawn.' : '') });
  b.push(s.returns.count
    ? { tone: 'bad', text: s.returns.count + ' returned or reversed instrument(s) — ' + inr(s.returns.items.reduce((t, r) => t + r.amount, 0)) + ' in all.' }
    : { tone: 'good', text: 'No returned, bounced or dishonoured instruments in this period.' });
  if (s.topCredits.length) {
    const top = s.topCredits[0];
    b.push({ tone: top.share >= 40 ? 'warn' : 'info', text: 'Largest source of credits: ' + top.name + ' at ' + top.share + '% of inflow' +
      (top.share >= 40 ? ' — concentrated.' : '.') });
  }
  if (s.emi.count) b.push({ tone: 'info', text: s.emi.count + ' EMI / mandate debit(s) totalling ' + inr(s.emi.amount) + '.' });
  if (s.salary.count) b.push({ tone: 'info', text: s.salary.count + ' salary-type credit(s) totalling ' + inr(s.salary.amount) + '.' });
  b.push(verifiedPct >= 90
    ? { tone: 'good', text: 'Running balances chain on ' + verifiedPct + '% of rows — the figures are reliable.' }
    : { tone: 'warn', text: 'Running balances chain on only ' + verifiedPct + '% of rows — some rows may have been misread, so treat the totals as indicative.' });
  if (a.reconciliation) {
    const ok = a.reconciliation.creditsMatch && a.reconciliation.debitsMatch && a.reconciliation.closingMatch;
    b.push({ tone: ok ? 'good' : 'warn', text: ok ? 'The totals agree with the summary the bank printed.' : 'The totals do not fully agree with the summary the bank printed.' });
  }
  return b;
}

/* ---------------- entry point ---------------- */
async function analysePdf(buffer, user) {
  const t0 = Date.now();
  const ex = await extractPdf(buffer);
  if (ex.status === 'unreadable' || ex.status === 'failed') {
    const e = new Error(ex.detail || 'The PDF could not be read.'); e.status = 400; throw e;
  }
  if (ex.status === 'ocr_required') {
    const e = new Error('This PDF is a scan with no text layer. Reading it needs OCR, which is not configured on this server — upload the bank’s own digital statement instead.');
    e.status = 400; throw e;
  }

  const lines = ex.units.filter((u) => u.kind === 'line');
  const text = lines.map((l) => l.text).join('\n');
  const source = ex.ocrPages && ex.ocrPages.length ? 'mixed' : 'text';

  const openMatch = /opening\s+balance[^\d\n-]{0,30}(-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})/i.exec(text);
  const opening = openMatch ? parseFloat(openMatch[1].replace(/,/g, '')) : null;

  const rows = parseRows(lines);
  const base = {
    at: new Date().toISOString(), by: user ? user.name : 'system', source, pages: ex.pageCount || 0,
    transactionCount: 0, ocrPages: ex.ocrPages || [], ms: 0
  };

  if (rows.length < 3) {
    return Object.assign(base, {
      kind: 'document', summary: null, transactions: [], reconciliation: null, ms: Date.now() - t0,
      bullets: [{ tone: 'info', text: 'No bank-statement rows were recognised — ' + lines.length + ' line(s) of text across ' + (ex.pageCount || 0) +
        ' page(s). This does not look like a bank statement.' }]
    });
  }

  const verified = assignDirections(rows, opening);
  const verifiedPct = Math.round(verified / rows.length * 100);
  const summary = summarise(rows, text);
  if (opening != null) summary.openingBalance = opening;
  const a = Object.assign(base, {
    kind: 'bank_statement', transactionCount: rows.length, summary,
    transactions: rows.map((r) => ({ date: r.date, narration: r.narration, direction: r.direction, amount: r.amount, balance: r.balance, verified: !!r.verified })),
    verifiedPct, reconciliation: reconcile(text, summary)
  });
  a.bullets = bulletsFor(a, summary, verifiedPct);
  a.ms = Date.now() - t0;
  return a;
}

module.exports = { analysePdf, parseRows, assignDirections, parseDate, parseMoney, summarise, counterparty };
