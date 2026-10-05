'use strict';
/* ============================================================================
   Submission readiness (spec §8.1, §9, §10).

   Every gate is computed from live data, never stored, so it cannot drift.
   "block" gates stop the analyst submitting; "warn" items carry into the
   memo and the review queue.
   ========================================================================== */
const { q } = require('../db/pool');
const uwrepo = require('./repo');
const checklist = require('./checklist');
const bank = require('./bank');
const engine = require('./engine');
const memo = require('./memo');
const { entityMatch } = require('./classify');

async function versionsUsedNow() {
  const day = await engine.dbToday();
  const pick = async (table) => engine.latestEffective((await q('SELECT * FROM ' + table + " WHERE status = 'approved'")).map(
    table === 'uw_formulas' ? uwrepo.mapFormula : table === 'uw_recon_defs' ? uwrepo.mapReconDef : uwrepo.mapRule), day)
    .filter((o) => table !== 'uw_rules' || o.threshold != null)
    .map((o) => o.id).sort((a, b) => a - b);
  return { formulas: await pick('uw_formulas'), reconciliations: await pick('uw_recon_defs'), rules: await pick('uw_rules') };
}

async function compute(caseId) {
  const c = await uwrepo.getCase(caseId);
  const party = await uwrepo.getParty(c.partyId);
  const gates = [];
  const add = (key, ok, severity, message, count = null) => gates.push({ key, ok, severity, message, count });

  /* documents */
  const list = await checklist.compute(c);
  const outstanding = list.filter((i) => i.mandatory && checklist.OUTSTANDING.includes(i.state));
  add('checklist', !outstanding.length, 'block',
    outstanding.length ? outstanding.length + ' mandatory checklist item(s) missing, unreadable or period-incomplete: ' + outstanding.map((i) => i.label).join('; ') : 'Mandatory checklist satisfied.',
    outstanding.length);

  const versions = await q(
    "SELECT id, original_name, intake_status, extraction_status, detected_type, classification_confirmed, entity_name FROM uw_document_versions WHERE case_id = ? AND intake_status <> 'duplicate'", [caseId]);
  const unconfirmed = versions.filter((v) => v.intake_status === 'accepted' && v.detected_type !== 'zip' && !v.classification_confirmed);
  add('classification', !unconfirmed.length, 'block',
    unconfirmed.length ? unconfirmed.length + ' file(s) still need their classification confirmed.' : 'Every accepted file is classified.', unconfirmed.length);

  const mismatched = versions.filter((v) => v.intake_status === 'accepted' && entityMatch(v.entity_name, party) === 'mismatch');
  add('entity', !mismatched.length, 'block',
    mismatched.length ? 'Entity name on ' + mismatched.length + ' file(s) does not match the borrower or its aliases — resolve before analysis (' + mismatched.map((v) => v.original_name).join(', ') + ').' : 'No entity mismatches.',
    mismatched.length);

  const quarantined = versions.filter((v) => v.intake_status === 'quarantined');
  if (quarantined.length) add('quarantine', false, 'warn', quarantined.length + ' file(s) quarantined — see the recoverable action on each.', quarantined.length);
  const ocr = versions.filter((v) => v.intake_status === 'accepted' && v.extraction_status === 'ocr_required');
  if (ocr.length) add('ocr', false, 'warn', ocr.length + ' scanned file(s) need manual reading (no OCR configured).', ocr.length);

  /* facts */
  const [{ proposed, provisional }] = await q(
    `SELECT SUM(review_status = 'proposed') AS proposed, SUM(review_status = 'provisional') AS provisional
       FROM uw_facts WHERE case_id = ? AND is_current = 1`, [caseId]);
  add('facts_reviewed', !Number(proposed), 'block', Number(proposed) ? proposed + ' proposed fact(s) await review.' : 'All facts reviewed.', Number(proposed) || 0);
  if (Number(provisional)) add('facts_provisional', false, 'warn', provisional + ' provisional fact(s) are in use; dependent outputs are flagged provisional.', Number(provisional));

  /* bank */
  const b = await bank.analyse(caseId);
  add('bank_review', !b.flags.reviewNeeded, 'block',
    b.flags.reviewNeeded ? b.flags.reviewNeeded + ' bank receipt(s) (financing, unknown or auto-matched transfers) need analyst verification.' : 'Bank receipts verified.',
    b.flags.reviewNeeded);
  const unacked = b.flags.failedValidations.filter((v) => !v.acknowledged);
  add('bank_validation', !unacked.length, 'block',
    unacked.length ? unacked.length + ' statement(s) failed balance validation and need an analyst note.' : 'Statement validations reviewed.', unacked.length);
  b.accounts.forEach((a) => { if (a.coverage.gaps.length) add('bank_gap_' + a.account.id, false, 'warn', a.account.alias + ': ' + a.coverage.gaps.length + ' gap(s) in statement coverage.', a.coverage.gaps.length); });

  /* analysis currency */
  const res = await engine.results(caseId);
  const now = await versionsUsedNow();
  const used = res.run ? res.run.versions || {} : null;
  const ids = (xs) => (xs || []).map((x) => x.id).sort((x, y) => x - y).join(',');
  const bookFresh = used && ids(used.formulas) === now.formulas.join(',') && ids(used.reconciliations) === now.reconciliations.join(',') && ids(used.rules) === now.rules.join(',');
  const dataFresh = res.run && res.run.inputSeq === c.changeSeq;
  add('analysis_current', !!(bookFresh && dataFresh), 'block',
    !res.run ? 'The analysis has not been run yet.'
      : !dataFresh ? 'Evidence changed after the last analysis run — re-run the analysis.'
        : !bookFresh ? 'The Credit Logic Book changed since the last analysis run — re-run the analysis.'
          : 'Analysis is current: latest evidence and the current Credit Logic Book.');

  /* policy */
  const disp = (await q('SELECT * FROM uw_rule_dispositions WHERE case_id = ? AND revision = ?', [caseId, c.revision])).map(uwrepo.mapDisposition);
  const has = (r, kind) => disp.some((d) => d.ruleCode === r.ruleCode && d.ruleVersion === r.ruleVersion && d.kind === kind);
  const hard = res.rules.filter((r) => r.ruleClass === 'hard_stop' && r.outcome !== 'not_triggered' && !has(r, 'override'));
  add('hard_stops', !hard.length, 'block',
    hard.length ? hard.length + ' hard stop(s) triggered or not evaluable: ' + hard.map((r) => r.ruleCode).join(', ') + '.' : 'No open hard stops.', hard.length);
  const ex = res.rules.filter((r) => r.ruleClass === 'committee_exception' && r.outcome !== 'not_triggered' && !has(r, 'exception_review'));
  add('exceptions', !ex.length, 'block',
    ex.length ? ex.length + ' committee exception(s) need an assigned reviewer and rationale: ' + ex.map((r) => r.ruleCode).join(', ') + '.' : 'Committee exceptions dispositioned.', ex.length);
  const warns = res.rules.filter((r) => r.ruleClass === 'warning' && r.outcome === 'triggered');
  if (warns.length) add('warnings', false, 'warn', warns.length + ' policy warning(s) triggered — they stay visible in the memo.', warns.length);

  const reconOpen = res.recons.filter((r) => r.outcome === 'outside_tolerance' && r.resolution !== 'explained');
  if (reconOpen.length) add('recon', false, 'warn', reconOpen.length + ' reconciliation difference(s) outside tolerance are unexplained.', reconOpen.length);
  const reconNoTol = res.recons.filter((r) => r.outcome === 'tolerance_not_configured');
  if (reconNoTol.length) add('recon_tolerance', false, 'warn', reconNoTol.length + ' reconciliation(s) have no configured tolerance.', reconNoTol.length);
  const nc = res.calcs.filter((r) => r.status === 'not_computable');
  if (nc.length) add('not_computable', false, 'warn', nc.length + ' measure(s) not computable.', nc.length);

  /* investigation */
  const checks = (await q('SELECT status FROM uw_public_checks WHERE case_id = ?', [caseId]));
  const pending = checks.filter((x) => x.status === 'pending').length;
  add('checks_pending', !pending, 'block', pending ? pending + ' public check task(s) not yet done (record failed / manual review if the site cannot be used).' : 'Public check tasks recorded.', pending);
  const unresolved = checks.filter((x) => ['failed', 'manual_review_required'].includes(x.status)).length;
  if (unresolved) add('checks_unresolved', false, 'warn', unresolved + ' public check(s) failed or need manual review — never reported as clear.', unresolved);
  const [{ openQ }] = await q("SELECT COUNT(*) AS openQ FROM uw_questions WHERE case_id = ? AND status = 'open'", [caseId]);
  if (Number(openQ)) add('questions', false, 'warn', openQ + ' borrower question(s) unanswered.', Number(openQ));

  /* memo */
  const { sections } = await memo.getSections(caseId);
  const empty = ['summary', 'terms'].filter((k) => !String(sections[k] || '').trim());
  add('memo_required', !empty.length, 'block', empty.length ? 'Write the ' + empty.join(' and ') + ' section(s) of the memo.' : 'Required memo sections written.');
  const mv = await memo.validate(caseId, sections);
  add('memo_citations', !mv.errors.length, 'block',
    mv.errors.length ? mv.errors.length + ' citation problem(s) in the memo.' : 'Every figure in the memo is cited and matches.', mv.errors.length);
  if (!c.terms || c.terms.amountPaise == null) add('terms', false, 'block', 'Record the proposed terms (amount and tenor).');
  else add('terms', true, 'block', 'Proposed terms recorded.');

  const blocking = gates.filter((g) => g.severity === 'block' && !g.ok);
  return { ready: !blocking.length, gates, checklist: list, memo: mv };
}

module.exports = { compute, versionsUsedNow };
