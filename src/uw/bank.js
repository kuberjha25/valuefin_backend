'use strict';
/* ============================================================================
   Bank analysis (spec §4, §6).

   Statements are imported from extracted spreadsheet / CSV cells through an
   explicit column mapping the analyst confirms, so every transaction row
   points back at its sheet and row. Parsing is strict: a row that cannot be
   read is reported, never skipped silently.

   Classification is layered and always explainable:
     analyst decision  >  inter-account transfer match  >  keyword rule  >  unknown
   Pattern flags are investigative leads, not fraud findings.
   ========================================================================== */
const crypto = require('crypto');
const { q, tx } = require('../db/pool');
const money = require('./money');
const { CREDIT_CATEGORIES, DEBIT_CATEGORIES } = require('./vocab');
const uwrepo = require('./repo');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DATE_FORMATS = ['DD/MM/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'DD/MM/YY', 'DD-MM-YY', 'YYYY-MM-DD', 'DD-MMM-YYYY', 'DD MMM YYYY', 'DD-MMM-YY', 'DD MMM YY', 'MM/DD/YYYY', 'EXCEL_SERIAL'];

const pad = (x) => String(x).padStart(2, '0');
function validYmd(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + pad(m) + '-' + pad(d);
}

/* Parse a statement date strictly in the chosen format. A spreadsheet date
   cell is already stored as YYYY-MM-DD, which is unambiguous and accepted
   whatever the chosen format. */
function parseDate(raw, format) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(T00:00:00(\.000)?Z)?$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  const y2 = (yy) => 2000 + yy;            // two-digit years on statements are this century
  switch (format) {
    case 'DD/MM/YYYY': case 'DD-MM-YYYY': case 'DD.MM.YYYY': {
      const sep = format[2] === '.' ? '\\.' : format[2];
      m = new RegExp('^(\\d{1,2})' + sep + '(\\d{1,2})' + sep + '(\\d{4})$').exec(s);
      return m ? validYmd(+m[3], +m[2], +m[1]) : null;
    }
    case 'DD/MM/YY': case 'DD-MM-YY': {
      m = new RegExp('^(\\d{1,2})' + format[2] + '(\\d{1,2})' + format[2] + '(\\d{2})$').exec(s);
      return m ? validYmd(y2(+m[3]), +m[2], +m[1]) : null;
    }
    case 'MM/DD/YYYY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      return m ? validYmd(+m[3], +m[1], +m[2]) : null;
    case 'YYYY-MM-DD':
      return null;                          // handled above
    case 'DD-MMM-YYYY': case 'DD MMM YYYY': case 'DD-MMM-YY': case 'DD MMM YY': {
      m = /^(\d{1,2})[-\s]([A-Za-z]{3,4})[-\s,]*(\d{2}|\d{4})$/.exec(s);
      if (!m) return null;
      const mo = MONTHS[m[2].toLowerCase()];
      const yr = m[3].length === 2 ? y2(+m[3]) : +m[3];
      return mo ? validYmd(yr, mo, +m[1]) : null;
    }
    case 'EXCEL_SERIAL': {
      if (!/^\d{4,6}(\.0+)?$/.test(s)) return null;
      const serial = parseInt(s, 10);
      if (serial < 60) return null;        // avoid the 1900 leap-year bug region
      const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return validYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    default: return null;
  }
}

/* "1,23,456.00 Cr" / "500.00 Dr" / "-500" → paise (Dr = negative balance). */
function parseBalance(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { empty: true };
  let sign = 1n;
  const suffix = /\s*(cr|dr)\.?$/i.exec(s);
  if (suffix) { if (suffix[1].toLowerCase() === 'dr') sign = -1n; s = s.slice(0, suffix.index); }
  const r = money.toPaise(s, 'INR');
  if (!r) return { error: true };
  return { paise: r.paise * sign, rounded: r.rounded };
}
function parseAmount(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === '-' || s === '—') return { empty: true };
  const r = money.toPaise(s.replace(/\s*(cr|dr)\.?$/i, ''), 'INR');
  if (!r) return { error: true };
  return { paise: r.paise, rounded: r.rounded };
}

const normNarr = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

/* ---------------- import: parse cells into rows ---------------- */
async function loadSheetGrid(versionId, sheet) {
  const units = await q(
    "SELECT row_index, col_index, cell_ref, text FROM uw_evidence_units WHERE version_id = ? AND kind = 'cell' AND sheet = ? ORDER BY row_index, col_index",
    [versionId, sheet]);
  const grid = new Map();
  for (const u of units) {
    if (!grid.has(u.row_index)) grid.set(u.row_index, {});
    grid.get(u.row_index)[String(u.cell_ref).replace(/\d+$/, '')] = u.text == null ? '' : String(u.text);
  }
  return grid;
}

const COL = /^[A-Z]{1,3}$/;

/* Parse a mapped statement. Returns { rows, errors, skipped, summary }. */
async function parseStatement(m) {
  const fmt = DATE_FORMATS.includes(m.dateFormat) ? m.dateFormat : null;
  const problems = [];
  if (!fmt) problems.push('Pick a date format.');
  const c = m.columns || {};
  for (const k of ['date', 'narration', 'debit', 'credit', 'amount', 'drcr', 'balance', 'reference']) {
    if (c[k] && !COL.test(c[k])) problems.push('Column for ' + k + ' must be a column letter like B.');
  }
  if (!c.date) problems.push('Map the date column.');
  if (m.amountMode === 'split' && (!c.debit || !c.credit)) problems.push('Map both the debit and the credit columns.');
  if (m.amountMode === 'signed' && !c.amount) problems.push('Map the amount column.');
  if (m.amountMode === 'drcr' && (!c.amount || !c.drcr)) problems.push('Map the amount and the Dr/Cr column.');
  if (!['split', 'signed', 'drcr'].includes(m.amountMode)) problems.push('Choose how amounts are laid out.');
  if (problems.length) return { problems };

  const grid = await loadSheetGrid(m.versionId, m.sheet);
  if (!grid.size) return { problems: ['No cells found on sheet "' + m.sheet + '".'] };
  const first = Number(m.firstRow) || 1;
  const last = Number(m.lastRow) || Math.max(...grid.keys());
  const exclude = new Set((m.excludeRows || []).map(Number));

  const rows = [], errors = [], skipped = [];
  for (let r = first; r <= last; r++) {
    if (exclude.has(r)) { skipped.push({ row: r, why: 'excluded by analyst' }); continue; }
    const cells = grid.get(r) || {};
    const get = (k) => (c[k] ? (cells[c[k]] || '').trim() : '');
    const mapped = ['date', 'narration', 'debit', 'credit', 'amount', 'drcr', 'balance', 'reference'].filter((k) => c[k]).map(get);
    if (mapped.every((v) => !v)) { skipped.push({ row: r, why: 'blank' }); continue; }

    const err = (msg) => errors.push({ row: r, message: msg });
    const date = parseDate(get('date'), fmt);
    if (!date) { err('Date "' + get('date').slice(0, 30) + '" does not match ' + fmt + '.'); continue; }

    let direction, amt;
    if (m.amountMode === 'split') {
      const d = parseAmount(get('debit')), cr = parseAmount(get('credit'));
      if (d.error || cr.error) { err('Debit/credit is not a number.'); continue; }
      const dv = d.empty ? 0n : d.paise, cv = cr.empty ? 0n : cr.paise;
      if (dv < 0n || cv < 0n) { err('Debit and credit must not be negative in split layout.'); continue; }
      if (dv !== 0n && cv !== 0n) { err('Both debit and credit are filled.'); continue; }
      if (dv === 0n && cv === 0n) { err('Neither debit nor credit has an amount.'); continue; }
      direction = dv ? 'debit' : 'credit'; amt = dv || cv;
    } else if (m.amountMode === 'signed') {
      const a = parseAmount(get('amount'));
      if (a.error || a.empty || a.paise === 0n) { err('Amount is missing or not a number.'); continue; }
      direction = a.paise < 0n ? 'debit' : 'credit'; amt = a.paise < 0n ? -a.paise : a.paise;
    } else {
      const a = parseAmount(get('amount'));
      const t = get('drcr').toUpperCase().replace(/\./g, '');
      if (a.error || a.empty || a.paise <= 0n) { err('Amount is missing, zero, negative or not a number.'); continue; }
      if (['CR', 'C', 'CREDIT', 'DEPOSIT'].includes(t)) direction = 'credit';
      else if (['DR', 'D', 'DEBIT', 'WITHDRAWAL'].includes(t)) direction = 'debit';
      else { err('Dr/Cr value "' + t.slice(0, 20) + '" is not recognised.'); continue; }
      amt = a.paise;
    }
    if (amt > money.MAX_SAFE_PAISE) { err('Amount is too large.'); continue; }

    let balance = null;
    if (c.balance) {
      const b = parseBalance(get('balance'));
      if (b.error) { err('Balance "' + get('balance').slice(0, 30) + '" is not a number.'); continue; }
      if (!b.empty) balance = b.paise;
    }
    rows.push({ row: r, date, direction, amount: amt, balance, narration: get('narration').slice(0, 1000), reference: get('reference').slice(0, 120) });
  }

  // Statements list either oldest-first or newest-first. Decide from the
  // dates; anything else (dates jumping both ways) cannot be validated.
  let order = 'ascending';
  const asc = rows.every((x, i) => i === 0 || x.date >= rows[i - 1].date);
  const desc = rows.every((x, i) => i === 0 || x.date <= rows[i - 1].date);
  if (!asc && desc) order = 'descending';
  else if (!asc && !desc) order = 'unordered';
  const chrono = order === 'descending' ? rows.slice().reverse() : rows;

  const summary = validate(chrono, m, order);
  return { rows: chrono, errors, skipped, order, summary };
}

function toPaiseOpt(v, label) {
  if (v == null || String(v).trim() === '') return null;
  const b = parseBalance(v);
  if (b.error || b.empty) throw Object.assign(new Error(label + ' is not a number.'), { status: 400 });
  return b.paise;
}

/* Opening + Σcredits − Σdebits = closing, and row-to-row balance continuity. */
function validate(rows, m, order) {
  let credits = 0n, debits = 0n;
  for (const r of rows) { if (r.direction === 'credit') credits += r.amount; else debits += r.amount; }
  const out = {
    count: rows.length, credits: credits.toString(), debits: debits.toString(),
    from: rows.length ? rows[0].date : null, to: rows.length ? rows[rows.length - 1].date : null,
    breaks: [], checks: []
  };
  const userOpen = toPaiseOpt(m.openingBalance, 'Opening balance');
  const userClose = toPaiseOpt(m.closingBalance, 'Closing balance');
  const haveBal = rows.length && rows.every((r) => r.balance != null);

  if (order === 'unordered') out.checks.push('Rows are not in date order, so balances cannot be validated.');
  else if (haveBal) {
    for (let i = 1; i < rows.length; i++) {
      const expect = rows[i - 1].balance + (rows[i].direction === 'credit' ? rows[i].amount : -rows[i].amount);
      if (expect !== rows[i].balance && out.breaks.length < 50) {
        out.breaks.push({ row: rows[i].row, expectedPaise: expect.toString(), statedPaise: rows[i].balance.toString() });
      }
    }
    const derivedOpen = rows[0].balance - (rows[0].direction === 'credit' ? rows[0].amount : -rows[0].amount);
    out.openingPaise = (userOpen != null ? userOpen : derivedOpen).toString();
    out.closingPaise = (userClose != null ? userClose : rows[rows.length - 1].balance).toString();
    if (userOpen != null && userOpen !== derivedOpen) out.checks.push('Stated opening balance differs from the first row\'s balance minus its amount.');
    if (userClose != null && userClose !== rows[rows.length - 1].balance) out.checks.push('Stated closing balance differs from the last row\'s balance.');
  } else if (userOpen != null) {
    out.openingPaise = userOpen.toString();
    if (userClose != null) out.closingPaise = userClose.toString();
  }
  if (out.openingPaise != null && out.closingPaise != null && order !== 'unordered') {
    const expectClose = BigInt(out.openingPaise) + credits - debits;
    if (expectClose !== BigInt(out.closingPaise)) {
      out.checks.push('Opening + credits − debits = ' + money.paiseToRupeeString(expectClose) + ', but closing is ' + money.paiseToRupeeString(out.closingPaise) + '.');
    }
  }
  const checked = order !== 'unordered' && (haveBal || (out.openingPaise != null && out.closingPaise != null));
  out.status = !checked ? 'not_checkable' : (out.breaks.length || out.checks.length) ? 'fail' : 'pass';
  if (order === 'unordered') out.status = 'fail';
  return out;
}

const dedupKey = (accountId, r, occurrence) => crypto.createHash('sha256').update([
  accountId, r.date, r.direction, r.amount.toString(), r.balance == null ? '' : r.balance.toString(), normNarr(r.narration), occurrence
].join('|')).digest('hex');

/* Commit a parsed statement: statement row + transactions, with duplicates of
   rows already imported (overlapping statements) flagged, not double-counted. */
async function commitStatement({ caseId, accountId, m, parsed, user }) {
  const s = parsed.summary;
  const periodFrom = m.periodFrom || s.from;
  const periodTo = m.periodTo || s.to;
  if (!periodFrom || !periodTo) throw Object.assign(new Error('The statement has no rows to import.'), { status: 400 });
  if (periodFrom > periodTo) throw Object.assign(new Error('Statement period starts after it ends.'), { status: 400 });

  const detail = [
    s.breaks.length ? s.breaks.length + ' balance break(s), first at row ' + s.breaks[0].row : '',
    ...s.checks
  ].filter(Boolean).join(' ');

  return tx(async (cx) => {
    const ins = await cx.q(
      `INSERT INTO uw_bank_statements (case_id, account_id, version_id, period_from, period_to, opening_paise, closing_paise,
         mapping, row_count, validation_status, validation_detail, created_by_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [caseId, accountId, m.versionId, periodFrom, periodTo, s.openingPaise == null ? null : s.openingPaise,
        s.closingPaise == null ? null : s.closingPaise,
        JSON.stringify({ sheet: m.sheet, firstRow: m.firstRow, lastRow: m.lastRow || null, columns: m.columns, amountMode: m.amountMode,
          dateFormat: m.dateFormat, excludeRows: m.excludeRows || [], order: parsed.order }),
        parsed.rows.length, s.status, detail.slice(0, 1000), user.id, user.name]);
    const statementId = ins.insertId;

    const existing = await cx.q('SELECT id, dedup_key FROM uw_transactions WHERE case_id = ? AND account_id = ? AND duplicate_of_id IS NULL', [caseId, accountId]);
    const byKey = new Map(existing.map((e) => [e.dedup_key, e.id]));
    const seen = new Map();
    let dups = 0;
    for (const r of parsed.rows) {
      const base = [r.date, r.direction, r.amount, r.balance, normNarr(r.narration)].join('|');
      const occ = (seen.get(base) || 0) + 1;
      seen.set(base, occ);
      const key = dedupKey(accountId, r, occ);
      const dupOf = byKey.get(key) || null;
      if (dupOf) dups++;
      const t = await cx.q(
        `INSERT INTO uw_transactions (case_id, account_id, statement_id, version_id, sheet, row_index, value_date, amount_paise,
           direction, balance_paise, raw_narration, reference, dedup_key, duplicate_of_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [caseId, accountId, statementId, m.versionId, m.sheet, r.row, r.date, r.amount.toString(), r.direction,
          r.balance == null ? null : r.balance.toString(), r.narration, r.reference, key, dupOf]);
      if (!dupOf) byKey.set(key, t.insertId);
    }
    await cx.q('UPDATE uw_bank_statements SET duplicate_count = ? WHERE id = ?', [dups, statementId]);
    return { statementId, imported: parsed.rows.length, duplicates: dups };
  });
}

/* ---------------- classification ---------------- */
const allowedFor = (dir) => (dir === 'credit' ? CREDIT_CATEGORIES : DEBIT_CATEGORIES);

/* Re-derive every non-analyst classification on the case: reset, apply the
   keyword rules, then pair inter-account transfers. Analyst decisions are
   never touched. */
async function reclassify(caseId) {
  const rules = (await q('SELECT * FROM uw_bank_rules WHERE active = 1 ORDER BY priority, id')).map(uwrepo.mapBankRule);
  const transferDays = Number(await uwrepo.getSetting('transfer_match_days', 0)) || 0;

  await tx(async (cx) => {
    await cx.q(
      `UPDATE uw_transactions SET category = 'unknown', category_source = 'none', category_rule_id = NULL,
              is_return = 0, transfer_pair_id = NULL, counterparty = IF(category_source = 'rule', '', counterparty)
        WHERE case_id = ? AND category_source <> 'analyst'`, [caseId]);
    const txns = await cx.q(
      "SELECT id, account_id, value_date, amount_paise, direction, raw_narration FROM uw_transactions WHERE case_id = ? AND category_source = 'none' AND duplicate_of_id IS NULL",
      [caseId]);

    for (const t of txns) {
      const narr = normNarr(t.raw_narration);
      const rule = rules.find((r) => (r.direction === 'any' || r.direction === t.direction)
        && allowedFor(t.direction).includes(r.category)
        && narr.includes(normNarr(r.pattern)));
      if (!rule) continue;
      t.ruled = true;
      await cx.q(
        "UPDATE uw_transactions SET category = ?, category_source = 'rule', category_rule_id = ?, is_return = ?, counterparty = IF(? <> '', ?, counterparty) WHERE id = ?",
        [rule.category, rule.id, rule.setsReturn ? 1 : 0, rule.counterparty, rule.counterparty, t.id]);
    }

    // Inter-account transfers: a debit on one supplied account and a credit of
    // the same amount on another, within the configured window. Paired only
    // when the match is unique in both directions — otherwise left for review.
    const open = txns.filter((t) => !t.ruled);
    const debits = open.filter((t) => t.direction === 'debit');
    const credits = open.filter((t) => t.direction === 'credit');
    const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
    const cand = new Map();
    for (const d of debits) {
      cand.set(d.id, credits.filter((c) => c.account_id !== d.account_id && String(c.amount_paise) === String(d.amount_paise)
        && days(c.value_date, d.value_date) <= transferDays));
    }
    const creditHits = new Map();
    for (const [, cs] of cand) for (const c of cs) creditHits.set(c.id, (creditHits.get(c.id) || 0) + 1);
    for (const d of debits) {
      const cs = cand.get(d.id);
      if (cs.length !== 1 || creditHits.get(cs[0].id) !== 1) continue;
      const c = cs[0];
      await cx.q("UPDATE uw_transactions SET category = 'internal_transfer', category_source = 'auto_transfer', transfer_pair_id = ? WHERE id = ?", [c.id, d.id]);
      await cx.q("UPDATE uw_transactions SET category = 'internal_transfer', category_source = 'auto_transfer', transfer_pair_id = ? WHERE id = ?", [d.id, c.id]);
    }
  });
}

/* ---------------- analytics ---------------- */
const monthOf = (d) => String(d).slice(0, 7);
function eachDay(from, to, fn) {
  const end = new Date(to + 'T00:00:00Z');
  for (let d = new Date(from + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) fn(d.toISOString().slice(0, 10));
}
const daysInMonth = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();

/* Which receipts must an analyst look at before submission (spec §6):
   financing, unknown and auto-matched transfer receipts not yet decided by an
   analyst, at or above the review threshold (every one, if no threshold set). */
function needsReview(t, thresholdPaise) {
  return t.direction === 'credit' && t.duplicateOfId == null && t.categorySource !== 'analyst'
    && ['financing', 'unknown', 'internal_transfer'].includes(t.category)
    && (thresholdPaise == null || t.amountPaise >= thresholdPaise);
}

async function analyse(caseId) {
  const accounts = (await q('SELECT * FROM uw_bank_accounts WHERE case_id = ? ORDER BY id', [caseId])).map(uwrepo.mapAccount);
  const statements = (await q('SELECT * FROM uw_bank_statements WHERE case_id = ? ORDER BY account_id, period_from', [caseId])).map(uwrepo.mapStatement);
  const txns = (await q('SELECT * FROM uw_transactions WHERE case_id = ? ORDER BY account_id, value_date, statement_id, row_index', [caseId])).map(uwrepo.mapTxn);
  const threshold = await uwrepo.getSetting('bank_review_threshold_paise', null);
  const thresholdPaise = threshold == null ? null : Number(threshold);

  const live = txns.filter((t) => t.duplicateOfId == null);
  // Within one statement, rows were stored in file order; a newest-first
  // statement must be walked backwards to be chronological.
  const descending = new Set(statements.filter((s) => s.mapping && s.mapping.order === 'descending').map((s) => s.id));
  live.sort((a, b) => (a.accountId - b.accountId) || (a.valueDate < b.valueDate ? -1 : a.valueDate > b.valueDate ? 1 : 0)
    || (a.statementId - b.statementId) || (descending.has(a.statementId) ? b.rowIndex - a.rowIndex : a.rowIndex - b.rowIndex));

  const blankMonth = () => ({
    credits: 0, operating: 0, financing: 0, owner_group: 0, internal_transfer: 0, tax_refund: 0, unknown: 0,
    debits: 0, debt_service: 0, internal_transfer_out: 0, returns: 0, txnCount: 0, minBalancePaise: null, avgBalancePaise: null
  });

  const perAccount = accounts.map((a) => {
    const st = statements.filter((s) => s.accountId === a.id);
    const tx_ = live.filter((t) => t.accountId === a.id);
    // Coverage: union of statement periods, and gaps inside it.
    const covered = new Set();
    st.forEach((s) => eachDay(s.periodFrom, s.periodTo, (d) => covered.add(d)));
    const sortedDays = Array.from(covered).sort();
    const gaps = [];
    if (sortedDays.length) {
      // The last day is covered by construction, so every gap opened here closes.
      let gap = null;
      eachDay(sortedDays[0], sortedDays[sortedDays.length - 1], (d) => {
        if (!covered.has(d)) { if (gap) gap.to = d; else gap = { from: d, to: d }; }
        else if (gap) { gaps.push(gap); gap = null; }
      });
    }
    const months = {};
    sortedDays.forEach((d) => { const k = monthOf(d); months[k] = months[k] || Object.assign(blankMonth(), { coveredDays: 0, totalDays: daysInMonth(k) }); months[k].coveredDays++; });

    for (const t of tx_) {
      const k = monthOf(t.valueDate);
      const mo = months[k] = months[k] || Object.assign(blankMonth(), { coveredDays: 0, totalDays: daysInMonth(k) });
      mo.txnCount++;
      if (t.isReturn) mo.returns++;
      if (t.direction === 'credit') { mo.credits += t.amountPaise; mo[t.category] = (mo[t.category] || 0) + t.amountPaise; }
      else {
        mo.debits += t.amountPaise;
        if (t.category === 'debt_service') mo.debt_service += t.amountPaise;
        if (t.category === 'internal_transfer') mo.internal_transfer_out += t.amountPaise;
      }
    }

    // End-of-day balances: only when every transaction carries a balance.
    const balOk = tx_.length > 0 && tx_.every((t) => t.balancePaise != null);
    if (balOk) {
      const eod = new Map();
      tx_.forEach((t) => eod.set(t.valueDate, t.balancePaise));
      const openingByStatement = st.filter((s) => s.openingPaise != null).sort((x, y) => (x.periodFrom < y.periodFrom ? -1 : 1));
      let running = openingByStatement.length ? openingByStatement[0].openingPaise : null;
      const sums = {};
      sortedDays.forEach((d) => {
        if (eod.has(d)) running = eod.get(d);
        if (running == null) return;
        const k = monthOf(d);
        sums[k] = sums[k] || { total: 0n, days: 0 };
        sums[k].total += BigInt(running); sums[k].days++;
        const mo = months[k];
        if (mo.minBalancePaise == null || running < mo.minBalancePaise) mo.minBalancePaise = running;
      });
      Object.entries(sums).forEach(([k, s]) => { months[k].avgBalancePaise = Number(money.divRound(s.total, BigInt(s.days))); });
    }

    return {
      account: a, statements: st,
      coverage: { from: sortedDays[0] || null, to: sortedDays[sortedDays.length - 1] || null, gaps, balanceTracked: balOk },
      months: Object.keys(months).sort().map((k) => Object.assign({ month: k }, months[k]))
    };
  });

  // Consolidated: transfers between the borrower's own accounts are removed
  // from turnover (spec §5 "Cash and bank").
  const cons = {};
  perAccount.forEach((pa) => pa.months.forEach((mo) => {
    const c = cons[mo.month] = cons[mo.month] || blankMonth();
    ['credits', 'operating', 'financing', 'owner_group', 'internal_transfer', 'tax_refund', 'unknown', 'debits', 'debt_service', 'internal_transfer_out', 'returns', 'txnCount']
      .forEach((f) => { c[f] += mo[f] || 0; });
  }));
  const consolidated = Object.keys(cons).sort().map((k) => Object.assign({ month: k }, cons[k], {
    adjustedCredits: cons[k].credits - cons[k].internal_transfer,
    adjustedDebits: cons[k].debits - cons[k].internal_transfer_out
  }));

  // Counterparty concentration of operating receipts.
  const op = live.filter((t) => t.direction === 'credit' && t.category === 'operating');
  const opTotal = op.reduce((s, t) => s + t.amountPaise, 0);
  const byCp = {};
  op.forEach((t) => {
    const k = t.counterparty || '';
    byCp[k] = byCp[k] || { amountPaise: 0, months: new Set(), count: 0 };
    byCp[k].amountPaise += t.amountPaise; byCp[k].months.add(monthOf(t.valueDate)); byCp[k].count++;
  });
  const pctStr = (part, whole) => (whole ? money.ratioString(BigInt(part), BigInt(whole), 100n, 2) : null);
  const counterparties = Object.entries(byCp).filter(([k]) => k).map(([k, v]) => ({
    counterparty: k, amountPaise: v.amountPaise, count: v.count, months: v.months.size,
    recurring: v.months.size >= 3, sharePct: pctStr(v.amountPaise, opTotal)
  })).sort((a, b) => b.amountPaise - a.amountPaise);
  const untaggedPaise = byCp[''] ? byCp[''].amountPaise : 0;

  const credits = live.filter((t) => t.direction === 'credit');
  const creditTotal = credits.reduce((s, t) => s + t.amountPaise, 0);
  const sumCat = (cat) => credits.filter((t) => t.category === cat).reduce((s, t) => s + t.amountPaise, 0);

  const review = live.filter((t) => needsReview(t, thresholdPaise));
  const returns = live.filter((t) => t.isReturn);
  const negative = [];
  perAccount.forEach((pa) => pa.months.forEach((mo) => { if (mo.minBalancePaise != null && mo.minBalancePaise < 0) negative.push({ account: pa.account.alias, month: mo.month, minBalancePaise: mo.minBalancePaise }); }));

  return {
    accounts: perAccount, consolidated, counterparties, untaggedOperatingPaise: untaggedPaise,
    totals: {
      creditsPaise: creditTotal, operatingPaise: sumCat('operating'), financingPaise: sumCat('financing'),
      ownerGroupPaise: sumCat('owner_group'), internalTransferPaise: sumCat('internal_transfer'),
      taxRefundPaise: sumCat('tax_refund'), unknownPaise: sumCat('unknown'),
      debitsPaise: live.filter((t) => t.direction === 'debit').reduce((s, t) => s + t.amountPaise, 0),
      debtServicePaise: live.filter((t) => t.direction === 'debit' && t.category === 'debt_service').reduce((s, t) => s + t.amountPaise, 0),
      duplicates: txns.length - live.length, transactions: live.length
    },
    metrics: {
      unknownCreditSharePct: pctStr(sumCat('unknown'), creditTotal),
      financingCreditSharePct: pctStr(sumCat('financing'), creditTotal),
      topCounterpartySharePct: counterparties.length ? counterparties[0].sharePct : null,
      returnCount: returns.length
    },
    flags: {
      reviewNeeded: review.length, reviewThresholdPaise: thresholdPaise,
      returns: returns.map((t) => ({ id: t.id, date: t.valueDate, amountPaise: t.amountPaise, narration: t.rawNarration })),
      negativeBalances: negative,
      failedValidations: statements.filter((s) => s.validationStatus === 'fail').map((s) => ({ id: s.id, accountId: s.accountId, acknowledged: !!s.ackBy, detail: s.validationDetail }))
    }
  };
}

module.exports = { DATE_FORMATS, parseDate, parseAmount, parseBalance, parseStatement, commitStatement, reclassify, analyse, needsReview, allowedFor };
