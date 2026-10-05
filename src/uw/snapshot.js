'use strict';
/* ============================================================================
   Frozen evidence + policy snapshot (spec §8.7, §10 "immutable decision
   snapshot", §13 "replay tests for each memo snapshot").

   Taken when the analyst submits. Canonical JSON (keys sorted) hashed with
   SHA-256 and stored once; the row is never updated. Checker and sanction
   decisions point at it, and the memo export can be re-rendered from it.
   ========================================================================== */
const crypto = require('crypto');
const { q } = require('../db/pool');
const uwrepo = require('./repo');
const facts = require('./facts');
const engine = require('./engine');
const bank = require('./bank');
const memo = require('./memo');
const readiness = require('./readiness');

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const hash = (payload) => crypto.createHash('sha256').update(canonical(payload)).digest('hex');

async function build(caseId) {
  const c = await uwrepo.getCase(caseId);
  const party = await uwrepo.getParty(c.partyId);
  const versions = (await q(
    `SELECT v.*, d.title, d.current_version_id FROM uw_document_versions v JOIN uw_documents d ON d.id = v.document_id
      WHERE v.case_id = ? ORDER BY v.id`, [caseId])).map(uwrepo.mapVersion);
  const ready = await readiness.compute(caseId);
  const results = await engine.results(caseId);
  const { sections } = await memo.getSections(caseId);
  const ids = (xs) => (xs || []).map((x) => x.id);
  const used = results.run ? results.run.versions || {} : {};
  const load = async (table, list, map) => (list.length ? (await q('SELECT * FROM ' + table + ' WHERE id IN (?)', [list])).map(map) : []);

  return {
    schema: 'valuefin.uw.snapshot/1',
    case: c, party,
    documents: versions.map((v) => ({
      id: v.id, documentId: v.documentId, version: v.version, sha256: v.sha256, originalName: v.originalName,
      detectedType: v.detectedType, source: v.source, sourcePath: v.sourcePath, intakeStatus: v.intakeStatus,
      scanStatus: v.scanStatus, extractionStatus: v.extractionStatus, docType: v.docType, auditStatus: v.auditStatus,
      periodStart: v.periodStart, periodEnd: v.periodEnd, entityName: v.entityName, classificationConfirmed: v.classificationConfirmed,
      receivedAt: v.receivedAt, uploadedBy: v.uploadedBy
    })),
    checklist: ready.checklist,
    facts: await facts.list(caseId, { all: true }),
    run: results.run, calculations: results.calcs, reconciliations: results.recons, rules: results.rules,
    creditLogicBook: {
      formulas: await load('uw_formulas', ids(used.formulas), uwrepo.mapFormula),
      reconciliations: await load('uw_recon_defs', ids(used.reconciliations), uwrepo.mapReconDef),
      rules: await load('uw_rules', ids(used.rules), uwrepo.mapRule)
    },
    dispositions: (await q('SELECT * FROM uw_rule_dispositions WHERE case_id = ? AND revision = ?', [caseId, c.revision])).map(uwrepo.mapDisposition),
    bank: await bank.analyse(caseId),
    publicChecks: (await q('SELECT pc.*, s.name AS source_name FROM uw_public_checks pc JOIN uw_sources s ON s.id = pc.source_id WHERE pc.case_id = ? ORDER BY pc.id', [caseId])).map(uwrepo.mapCheck),
    claims: (await q('SELECT * FROM uw_claims WHERE case_id = ? ORDER BY id', [caseId])).map(uwrepo.mapClaim),
    questions: (await q('SELECT * FROM uw_questions WHERE case_id = ? ORDER BY id', [caseId])).map(uwrepo.mapQuestion),
    memo: { sections, validation: ready.memo },
    readiness: ready.gates,
    settings: {
      transferMatchDays: await uwrepo.getSetting('transfer_match_days', 0),
      bankReviewThresholdPaise: await uwrepo.getSetting('bank_review_threshold_paise', null)
    }
  };
}

/* Freeze and store. Runs inside the caller's transaction. */
async function freeze(cx, caseId, revision, payload, user) {
  const sha = hash(payload);
  const r = await cx.q('INSERT INTO uw_snapshots (case_id, revision, payload, sha256, created_by_id, created_by) VALUES (?,?,?,?,?,?)',
    [caseId, revision, canonical(payload), sha, user.id, user.name]);
  return { id: r.insertId, sha256: sha };
}

async function get(snapshotId, caseId) {
  const rows = await q('SELECT * FROM uw_snapshots WHERE id = ? AND case_id = ?', [snapshotId, caseId]);
  if (!rows.length) return null;
  const r = rows[0];
  const payload = JSON.parse(r.payload);
  return { id: r.id, revision: r.revision, sha256: r.sha256, verified: hash(payload) === r.sha256, createdBy: r.created_by, createdAt: uwrepo.iso(r.created_at), payload };
}

module.exports = { build, freeze, get, canonical, hash };
