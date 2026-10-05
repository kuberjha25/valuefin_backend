'use strict';
/* Underwriting documents: batch / ZIP upload, immutable versions, the
   original-file stream, extracted evidence units and classification
   (spec §2.2–2.4, §4, §10 "Upload and coverage", "Evidence review"). */
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../../config');
const { q, tx } = require('../../db/pool');
const audit = require('../../audit');
const { notify } = require('../../notify');
const uwrepo = require('../../uw/repo');
const access = require('../../uw/access');
const store = require('../../uw/store');
const intake = require('../../uw/intake');
const classify = require('../../uw/classify');
const vocab = require('../../uw/vocab');
const { H, bad, notFound, optStr, reqId, optId, optDate, oneOf } = require('../../http');

const router = express.Router();

fs.mkdirSync(config.paths.uploadTmp, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: config.paths.uploadTmp,
    filename: (_req, _file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + '.upload')
  }),
  limits: { fileSize: config.uw.maxFileBytes, files: config.uw.maxBatchFiles }
});

/* Later evidence on a submitted case starts a new revision and review cycle
   (spec §8.7). The frozen snapshot of the earlier revision is untouched. */
async function reopenForNewEvidence(c, user) {
  if (!vocab.IN_REVIEW_STATUSES.includes(c.status)) return false;
  await tx(async (cx) => {
    const [row] = await cx.q('SELECT status, revision FROM uw_cases WHERE id = ? FOR UPDATE', [c.id]);
    if (!vocab.IN_REVIEW_STATUSES.includes(row.status)) return;
    await cx.q(
      "INSERT INTO uw_decisions (case_id, revision, stage, action, rationale, actor_id, actor_name, actor_role) VALUES (?,?,'system','reopen_new_evidence',?,?,?,?)",
      [c.id, row.revision, 'New evidence uploaded by ' + user.name + ' while the case was ' + row.status + '; revision ' + (row.revision + 1) + ' opened.', user.id, user.name, user.role]);
    await cx.q("UPDATE uw_cases SET status = 'open', revision = revision + 1 WHERE id = ?", [c.id]);
    // Carry the policy dispositions into the new cycle; the analyst can revisit them.
    await cx.q(
      `INSERT INTO uw_rule_dispositions (case_id, revision, rule_code, rule_version, kind, reviewer_id, reviewer_name, rationale, created_by_id, created_by)
       SELECT case_id, revision + 1, rule_code, rule_version, kind, reviewer_id, reviewer_name, rationale, created_by_id, created_by
         FROM uw_rule_dispositions WHERE case_id = ? AND revision = ?`, [c.id, row.revision]);
  });
  await notify({ toRole: 'manager', type: 'uw', message: c.caseCode + ' was reopened as a new revision because new evidence arrived.' });
  await notify({ toRole: 'director', type: 'uw', message: c.caseCode + ' was reopened as a new revision because new evidence arrived.' });
  return true;
}

router.post('/cases/:id/documents', (req, res, next) => {
  let me;
  try { me = access.requireMaker(req); } catch (e) { return next(e); }
  upload.array('files', config.uw.maxBatchFiles)(req, res, async (err) => {
    const temps = (req.files || []).map((f) => f.path);
    const cleanup = () => temps.forEach((p) => { try { fs.unlinkSync(p); } catch (_) { /* already gone */ } });
    if (err) {
      cleanup();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A file is larger than ' + Math.round(config.uw.maxFileBytes / 1048576) + ' MB.'
        : err.code === 'LIMIT_FILE_COUNT' ? 'At most ' + config.uw.maxBatchFiles + ' files per upload — zip larger sets.'
          : err.message;
      return next(Object.assign(new Error(msg), { status: 400 }));
    }
    try {
      const c = await access.loadCase(reqId(req.params.id, 'Case'));
      if (vocab.DECIDED_STATUSES.includes(c.status)) access.assertEditable(c);
      if (!req.files || !req.files.length) throw bad('Attach at least one file.');
      const source = oneOf(req.body.source, 'Source', ['upload', 'borrower_response', 'public_check'], 'upload');
      const documentId = optId(req.body.documentId, 'Document');
      if (documentId) {
        if (req.files.length !== 1) throw bad('Upload exactly one file as a new version of a document.');
        const d = await q('SELECT id FROM uw_documents WHERE id = ? AND case_id = ?', [documentId, c.id]);
        if (!d.length) throw bad('That document is not on this case.');
      }

      const reopened = await reopenForNewEvidence(c, me);
      const files = req.files.map((f) => ({ originalName: f.originalname, path: f.path, documentId }));
      const report = await intake.ingestBatch({ caseId: c.id, user: me, files, source });
      cleanup();

      const tally = report.reduce((t, r) => { t[r.intake] = (t[r.intake] || 0) + 1; return t; }, {});
      await audit.log(req, 'uw.document.upload', 'uw_case', c.id,
        me.name + ' uploaded ' + req.files.length + ' file(s) to ' + c.caseCode + ' — ' + Object.entries(tally).map(([k, v]) => v + ' ' + k).join(', '),
        { source, reopened, files: report.map((r) => ({ name: r.name, versionId: r.versionId, sha256: r.sha256, intake: r.intake, reason: r.reason })) });
      const ch = await access.changed(c.id, me, 'documents uploaded');
      res.json(Object.assign({ report, reopened }, ch));
    } catch (e) { cleanup(); next(e); }
  });
});

/* ---------------- list ---------------- */
router.get('/cases/:id/documents', H(async (req) => {
  access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  const party = await uwrepo.getParty(c.partyId);
  const rows = await q(
    `SELECT v.*, d.title, d.current_version_id,
            (SELECT COUNT(*) FROM uw_evidence_units u WHERE u.version_id = v.id) AS unit_count,
            (SELECT COUNT(*) FROM uw_facts f WHERE f.source_version_id = v.id) AS fact_refs
       FROM uw_document_versions v JOIN uw_documents d ON d.id = v.document_id
      WHERE v.case_id = ? ORDER BY v.document_id, v.version`, [c.id]);
  return rows.map((r) => Object.assign(uwrepo.mapVersion(r), {
    unitCount: Number(r.unit_count), factRefs: Number(r.fact_refs),
    entityMatch: classify.entityMatch(r.entity_name, party)
  }));
}));

/* ---------------- original file (immutable) ---------------- */
router.get('/cases/:id/versions/:vid/file', (req, res, next) => {
  Promise.resolve().then(async () => {
    const me = access.requireMaker(req);
    const caseId = reqId(req.params.id, 'Case');
    const v = await uwrepo.getVersion(reqId(req.params.vid, 'Version'));
    if (!v || v.caseId !== caseId) throw notFound('File not found.');
    if (!v.objectUri) throw notFound('This file was not kept (it was unreadable or infected).');
    const abs = store.pathForUri(v.objectUri);
    if (!abs || !fs.existsSync(abs)) throw notFound('The original is missing from the evidence store.');

    const inline = req.query.download !== '1' && (v.detectedType === 'pdf' || v.detectedType === 'image');
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' " + config.corsOrigin + '; sandbox allow-same-origin allow-scripts allow-popups');
    res.setHeader('Content-Type', inline ? v.mime : 'application/octet-stream');
    res.setHeader('Content-Length', fs.statSync(abs).size);
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + path.basename(v.originalName).replace(/["\\\r\n]/g, '_') + '"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-SHA256', v.sha256);
    await audit.log(req, 'uw.document.view', 'uw_case', caseId, me.name + ' opened "' + v.originalName + '" (v' + v.version + ')', { versionId: v.id, download: !inline });
    fs.createReadStream(abs).pipe(res);
  }).catch(next);
});

/* ---------------- extracted evidence units ---------------- */
router.get('/cases/:id/versions/:vid/units', H(async (req) => {
  access.requireMaker(req);
  const caseId = reqId(req.params.id, 'Case');
  const v = await uwrepo.getVersion(reqId(req.params.vid, 'Version'));
  if (!v || v.caseId !== caseId) throw notFound('File not found.');
  const sheets = await q("SELECT sheet, COUNT(*) AS n, MAX(row_index) AS rows_, MAX(col_index) AS cols FROM uw_evidence_units WHERE version_id = ? AND kind = 'cell' GROUP BY sheet ORDER BY MIN(id)", [v.id]);
  const pages = await q("SELECT page, COUNT(*) AS n FROM uw_evidence_units WHERE version_id = ? AND kind = 'line' GROUP BY page ORDER BY page", [v.id]);
  const where = ['version_id = ?'], args = [v.id];
  if (req.query.page) { where.push('page = ?'); args.push(Number(req.query.page)); }
  if (req.query.sheet) { where.push('sheet = ?'); args.push(String(req.query.sheet)); }
  if (req.query.q) { where.push('text LIKE ?'); args.push('%' + String(req.query.q) + '%'); }
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 2000));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const units = await q('SELECT * FROM uw_evidence_units WHERE ' + where.join(' AND ') + ' ORDER BY page, sheet, row_index, col_index, id LIMIT ' + limit + ' OFFSET ' + offset, args);
  return {
    version: v,
    sheets: sheets.map((s) => ({ sheet: s.sheet, cells: Number(s.n), rows: Number(s.rows_), cols: Number(s.cols) })),
    pages: pages.map((p) => ({ page: p.page, lines: Number(p.n) })),
    units: units.map(uwrepo.mapUnit), limit, offset
  };
}));

/* ---------------- classification (analyst confirms or corrects) ---------------- */
router.put('/cases/:id/versions/:vid/classification', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const v = await uwrepo.getVersion(reqId(req.params.vid, 'Version'));
  if (!v || v.caseId !== c.id) throw notFound('File not found.');
  if (v.intakeStatus === 'duplicate') throw bad('Classify the original, not the duplicate.');

  const docType = oneOf(req.body.docType, 'Document type', vocab.DOC_TYPE_KEYS);
  const auditStatus = oneOf(req.body.auditStatus, 'Audit status', vocab.AUDIT_STATUSES, 'unknown');
  const periodStart = optDate(req.body.periodStart, 'Period start');
  const periodEnd = optDate(req.body.periodEnd, 'Period end');
  if (periodStart && periodEnd && periodStart > periodEnd) throw bad('Period start is after period end.');
  if (periodStart && !periodEnd) throw bad('Give the period end as well.');
  const entityName = optStr(req.body.entityName, 'Entity name', { max: 190 });
  const bankAccountId = optId(req.body.bankAccountId, 'Bank account');
  if (bankAccountId) {
    const a = await q('SELECT id FROM uw_bank_accounts WHERE id = ? AND case_id = ?', [bankAccountId, c.id]);
    if (!a.length) throw bad('That bank account is not on this case.');
  }
  if (docType === 'unclassified') throw bad('Pick a document type.');

  await q(
    `UPDATE uw_document_versions SET doc_type = ?, audit_status = ?, period_start = ?, period_end = ?, entity_name = ?, bank_account_id = ?,
            classified_by = 'analyst', classification_confirmed = 1, classified_by_id = ?, classified_at = NOW(3) WHERE id = ?`,
    [docType, auditStatus, periodStart, periodEnd, entityName, bankAccountId, me.id, v.id]);
  const after = await uwrepo.getVersion(v.id);
  await audit.log(req, 'uw.document.classify', 'uw_case', c.id, me.name + ' classified "' + v.originalName + '" as ' + docType,
    { versionId: v.id, before: { docType: v.docType, auditStatus: v.auditStatus, periodStart: v.periodStart, periodEnd: v.periodEnd, entityName: v.entityName, confirmed: v.classificationConfirmed },
      after: { docType, auditStatus, periodStart, periodEnd, entityName, bankAccountId } });
  const ch = await access.changed(c.id, me, 'classification changed');
  const party = await uwrepo.getParty(c.partyId);
  return Object.assign(after, { entityMatch: classify.entityMatch(after.entityName, party) }, ch);
}));

/* ---------------- re-run extraction ---------------- */
router.post('/cases/:id/versions/:vid/extract', H(async (req) => {
  const me = access.requireMaker(req);
  const c = await access.loadCase(reqId(req.params.id, 'Case'));
  access.assertEditable(c);
  const v = await uwrepo.getVersion(reqId(req.params.vid, 'Version'));
  if (!v || v.caseId !== c.id) throw notFound('File not found.');
  if (v.intakeStatus !== 'accepted' || v.detectedType === 'zip') throw bad('Only accepted, non-archive files can be extracted.');
  const [{ refs }] = await q(
    `SELECT (SELECT COUNT(*) FROM uw_facts WHERE source_version_id = ?) + (SELECT COUNT(*) FROM uw_transactions WHERE version_id = ?) AS refs`, [v.id, v.id]);
  if (Number(refs)) throw bad('Facts or bank transactions already cite this file\'s extracted text, so it cannot be re-extracted.');
  const buf = store.read(v.objectUri);
  const result = await intake.runExtraction(v.id, c.id, v.detectedType, buf, v.originalName);
  await audit.log(req, 'uw.document.extract', 'uw_case', c.id, me.name + ' re-ran extraction on "' + v.originalName + '"', { versionId: v.id, status: result.status });
  return { status: result.status, detail: result.detail || '' };
}));

module.exports = router;
