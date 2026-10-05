'use strict';
/* Bank analysis routes (spec §6, §10 "Analysis — bank tab"). */
const express = require('express');
const { q, tx } = require('../../db/pool');
const audit = require('../../audit');
const uwrepo = require('../../uw/repo');
const access = require('../../uw/access');
const bank = require('../../uw/bank');
const { H, bad, notFound, reqStr, optStr, reqId, optId } = require('../../http');

const router = express.Router();

router.get('/cases/:id/bank', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  return bank.analyse(c.id);
}));

router.post('/cases/:id/bank/accounts', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const alias = reqStr(req.body.alias, 'Account alias', { max: 80 });
  const last4 = optStr(req.body.accountLast4, 'Last 4 digits', { max: 4 });
  if (last4 && !/^\d{4}$/.test(last4)) throw bad('Give only the last 4 digits of the account number.');
  const dupe = await q('SELECT id FROM uw_bank_accounts WHERE case_id = ? AND alias = ?', [c.id, alias]);
  if (dupe.length) throw bad('An account with that alias already exists on this case.');
  const r = await q('INSERT INTO uw_bank_accounts (case_id, alias, bank_name, account_last4, account_type, created_by) VALUES (?,?,?,?,?,?)',
    [c.id, alias, optStr(req.body.bankName, 'Bank', { max: 120 }), last4, optStr(req.body.accountType, 'Account type', { max: 40 }), me.name]);
  await audit.log(req, 'uw.bank.account', 'uw_case', c.id, me.name + ' added bank account "' + alias + '"', { accountId: r.insertId });
  return uwrepo.mapAccount((await q('SELECT * FROM uw_bank_accounts WHERE id = ?', [r.insertId]))[0]);
}));

async function readMapping(c, body) {
  const versionId = reqId(body.versionId, 'Statement file');
  const v = await uwrepo.getVersion(versionId);
  if (!v || v.caseId !== c.id) throw bad('That file is not on this case.');
  if (v.intakeStatus !== 'accepted') throw bad('Import from an accepted file.');
  if (!['xlsx', 'csv'].includes(v.detectedType)) throw bad('Statements are imported from spreadsheet or CSV files. For a PDF statement, ask for the bank\'s Excel/CSV export, or record the key figures as facts.');
  const accountId = reqId(body.accountId, 'Bank account');
  const a = await q('SELECT id FROM uw_bank_accounts WHERE id = ? AND case_id = ?', [accountId, c.id]);
  if (!a.length) throw bad('That bank account is not on this case.');
  const firstRow = Number(body.firstRow);
  if (!Number.isInteger(firstRow) || firstRow < 1) throw bad('First data row must be a row number.');
  const lastRow = body.lastRow == null || body.lastRow === '' ? null : Number(body.lastRow);
  if (lastRow != null && (!Number.isInteger(lastRow) || lastRow < firstRow)) throw bad('Last row must be on or after the first row.');
  const columns = {};
  for (const [k, val] of Object.entries(body.columns || {})) {
    if (val == null || val === '') continue;
    columns[k] = String(val).trim().toUpperCase();
  }
  return {
    versionId, accountId, sheet: reqStr(body.sheet, 'Sheet', { max: 100 }), firstRow, lastRow, columns,
    amountMode: body.amountMode, dateFormat: body.dateFormat,
    openingBalance: body.openingBalance, closingBalance: body.closingBalance,
    periodFrom: body.periodFrom || null, periodTo: body.periodTo || null,
    excludeRows: Array.isArray(body.excludeRows) ? body.excludeRows.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000) : []
  };
}

const describe = (parsed) => ({
  order: parsed.order, summary: parsed.summary, errors: parsed.errors, skipped: parsed.skipped.slice(0, 200),
  skippedCount: parsed.skipped.length,
  preview: parsed.rows.slice(0, 60).map((r) => ({ row: r.row, date: r.date, direction: r.direction, amountPaise: r.amount.toString(), balancePaise: r.balance == null ? null : r.balance.toString(), narration: r.narration }))
});

router.post('/cases/:id/bank/import/preview', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const m = await readMapping(c, req.body);
  const parsed = await bank.parseStatement(m);
  if (parsed.problems) throw bad(parsed.problems.join(' '));
  return describe(parsed);
}));

router.post('/cases/:id/bank/import/commit', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const m = await readMapping(c, req.body);
  const parsed = await bank.parseStatement(m);
  if (parsed.problems) throw bad(parsed.problems.join(' '));
  if (parsed.errors.length) {
    throw bad(parsed.errors.length + ' row(s) could not be read (first: row ' + parsed.errors[0].row + ' — ' + parsed.errors[0].message + '). Fix the mapping or exclude those rows explicitly.');
  }
  if (!parsed.rows.length) throw bad('No transaction rows found with this mapping.');
  const out = await bank.commitStatement({ caseId: c.id, accountId: m.accountId, m, parsed, user: me });
  await bank.reclassify(c.id);
  await audit.log(req, 'uw.bank.import', 'uw_case', c.id,
    me.name + ' imported ' + out.imported + ' transaction(s) (' + out.duplicates + ' duplicate) — validation ' + parsed.summary.status,
    { statementId: out.statementId, versionId: m.versionId, mapping: m, validation: parsed.summary });
  return Object.assign(out, { validation: parsed.summary }, await access.changed(c.id, me, 'bank statement imported'));
}));

router.post('/cases/:id/bank/statements/:sid/acknowledge', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const sid = reqId(req.params.sid, 'Statement');
  const s = await q('SELECT * FROM uw_bank_statements WHERE id = ? AND case_id = ?', [sid, c.id]);
  if (!s.length) throw notFound('Statement not found.');
  if (s[0].validation_status !== 'fail') throw bad('Only a failed validation needs acknowledging.');
  const note = reqStr(req.body.note, 'Note', { max: 1000 });
  await q('UPDATE uw_bank_statements SET ack_note = ?, ack_by = ?, ack_at = NOW(3) WHERE id = ?', [note, me.name, sid]);
  await audit.log(req, 'uw.bank.validation.ack', 'uw_case', c.id, me.name + ' acknowledged a failed statement validation', { statementId: sid, note, detail: s[0].validation_detail });
  return { ok: true };
}));

router.delete('/cases/:id/bank/statements/:sid', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const sid = reqId(req.params.sid, 'Statement');
  const s = await q('SELECT * FROM uw_bank_statements WHERE id = ? AND case_id = ?', [sid, c.id]);
  if (!s.length) throw notFound('Statement not found.');
  const [{ cited }] = await q('SELECT COUNT(*) AS cited FROM uw_facts f JOIN uw_transactions t ON t.id = f.source_txn_id WHERE t.statement_id = ?', [sid]);
  if (Number(cited)) throw bad('Facts cite transactions from this statement; correct those facts first.');
  const [{ deps }] = await q('SELECT COUNT(*) AS deps FROM uw_transactions d JOIN uw_transactions t ON t.id = d.duplicate_of_id WHERE t.statement_id = ? AND d.statement_id <> ?', [sid, sid]);
  if (Number(deps)) throw bad('Another statement\'s rows are duplicates of this one\'s; remove that statement first.');
  await tx(async (cx) => {
    await cx.q('UPDATE uw_transactions SET transfer_pair_id = NULL WHERE transfer_pair_id IN (SELECT id FROM (SELECT id FROM uw_transactions WHERE statement_id = ?) x)', [sid]);
    await cx.q('DELETE FROM uw_bank_statements WHERE id = ?', [sid]);
  });
  await bank.reclassify(c.id);
  await audit.log(req, 'uw.bank.statement.delete', 'uw_case', c.id, me.name + ' removed an imported statement (' + s[0].row_count + ' rows)', { statementId: sid, mapping: uwrepo.j(s[0].mapping) });
  return access.changed(c.id, me, 'bank statement removed');
}));

router.get('/cases/:id/bank/transactions', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const where = ['case_id = ?'], args = [c.id];
  const accountId = optId(req.query.accountId, 'Account');
  if (accountId) { where.push('account_id = ?'); args.push(accountId); }
  if (req.query.category) { where.push('category = ?'); args.push(String(req.query.category)); }
  if (req.query.direction) { where.push('direction = ?'); args.push(req.query.direction === 'debit' ? 'debit' : 'credit'); }
  if (req.query.duplicates !== '1') where.push('duplicate_of_id IS NULL');
  if (req.query.q) { where.push('(raw_narration LIKE ? OR counterparty LIKE ?)'); args.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 300));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  let rows = (await q('SELECT * FROM uw_transactions WHERE ' + where.join(' AND ') + ' ORDER BY value_date, account_id, id', args)).map(uwrepo.mapTxn);
  if (req.query.review === '1') {
    const thr = await uwrepo.getSetting('bank_review_threshold_paise', null);
    rows = rows.filter((t) => bank.needsReview(t, thr == null ? null : Number(thr)));
  }
  return { total: rows.length, rows: rows.slice(offset, offset + limit), limit, offset };
}));

router.post('/cases/:id/bank/transactions/classify', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) throw bad('Select at least one transaction.');
  if (ids.length > 2000) throw bad('Classify at most 2000 transactions at a time.');
  const rows = await q('SELECT * FROM uw_transactions WHERE case_id = ? AND id IN (?)', [c.id, ids]);
  if (rows.length !== ids.length) throw bad('Some transactions are not on this case.');
  const category = req.body.category;
  if (category != null) {
    const wrong = rows.filter((t) => !bank.allowedFor(t.direction).includes(category));
    if (wrong.length) throw bad('"' + category + '" is not a valid category for ' + wrong[0].direction + 's.');
  }
  const counterparty = req.body.counterparty == null ? null : optStr(req.body.counterparty, 'Counterparty', { max: 190 });
  const isReturn = req.body.isReturn == null ? null : !!req.body.isReturn;
  await q(
    `UPDATE uw_transactions SET category = COALESCE(?, category), counterparty = COALESCE(?, counterparty),
            is_return = COALESCE(?, is_return), category_source = 'analyst', category_rule_id = NULL, transfer_pair_id = NULL,
            classified_by_id = ?, classified_by = ?, classified_at = NOW(3)
      WHERE case_id = ? AND id IN (?)`,
    [category || null, counterparty, isReturn == null ? null : (isReturn ? 1 : 0), me.id, me.name, c.id, ids]);
  // An analyst decision on one side of an auto-matched transfer unpairs the other side.
  await bank.reclassify(c.id);
  await audit.log(req, 'uw.bank.classify', 'uw_case', c.id,
    me.name + ' classified ' + ids.length + ' transaction(s)' + (category ? ' as ' + category : ''),
    { ids, category, counterparty, isReturn, before: rows.map((t) => ({ id: t.id, category: t.category, source: t.category_source, counterparty: t.counterparty, isReturn: !!t.is_return })) });
  return access.changed(c.id, me, 'bank classification');
}));

module.exports = router;
