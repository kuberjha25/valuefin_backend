'use strict';
/* ============================================================================
   Intake: the path every underwriting file takes (spec §2.2–2.3, §4).

     bytes → type check → malware scan → SHA-256 → duplicate check
           → immutable store → document version row → classification
           suggestion → extraction → evidence units

   ZIPs are opened entry by entry under the shared budget in ingest.js, and
   each member becomes its own document version pointing at its container.
   A problem with one file never discards the others: it is quarantined with
   the reason and the action that would fix it.
   ========================================================================== */
const fs = require('fs');
const config = require('../config');
const { q, tx } = require('../db/pool');
const store = require('./store');
const ingest = require('./ingest');
const { extract } = require('./extract');
const classify = require('./classify');

const safeName = (s) => String(s || 'file').replace(/[\u0000-\u001f]/g, '').slice(0, 255);

async function nextVersionNumber(run, documentId) {
  const [{ v }] = await run('SELECT COALESCE(MAX(version), 0) AS v FROM uw_document_versions WHERE document_id = ?', [documentId]);
  return Number(v) + 1;
}

/* Create the document (or a new version of an existing one) and its version row. */
async function insertVersion(cx, caseId, row, documentId) {
  let docId = documentId;
  if (!docId) {
    const d = await cx.q('INSERT INTO uw_documents (case_id, title) VALUES (?, ?)', [caseId, row.title.slice(0, 255)]);
    docId = d.insertId;
  }
  const version = await nextVersionNumber(cx.q, docId);
  const r = await cx.q(
    `INSERT INTO uw_document_versions
       (document_id, case_id, version, sha256, original_name, mime, detected_type, size_bytes, source, source_path,
        parent_version_id, object_uri, uploaded_by_id, uploaded_by, scan_status, scan_detail, intake_status,
        duplicate_of_id, quarantine_reason, recoverable_action, extraction_status, extraction_detail, doc_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [docId, caseId, version, row.sha256, safeName(row.originalName), row.mime || '', row.detectedType, row.sizeBytes,
      row.source, (row.sourcePath || '').slice(0, 512), row.parentVersionId || null, row.objectUri || null,
      row.user.id, row.user.name, row.scanStatus, (row.scanDetail || '').slice(0, 255), row.intakeStatus,
      row.duplicateOfId || null, (row.quarantineReason || '').slice(0, 255), (row.recoverableAction || '').slice(0, 255),
      row.extractionStatus, (row.extractionDetail || '').slice(0, 500), row.docType || 'unclassified']);
  // Only an accepted version becomes the one the document points at.
  if (row.intakeStatus === 'accepted') {
    await cx.q('UPDATE uw_documents SET current_version_id = ? WHERE id = ?', [r.insertId, docId]);
  }
  return { versionId: r.insertId, documentId: docId, version };
}

/* Persist extraction output for one version, replacing nothing: a version is
   extracted once (re-extraction is refused once facts or transactions cite it). */
async function saveExtraction(versionId, caseId, result, suggestion) {
  await tx(async (cx) => {
    await cx.q('DELETE FROM uw_evidence_units WHERE version_id = ?', [versionId]);
    const cols = ['case_id', 'version_id', 'kind', 'page', 'bbox', 'sheet', 'cell_ref', 'row_index', 'col_index', 'text', 'formula', 'merged_range', 'number_format'];
    for (let i = 0; i < result.units.length; i += 500) {
      const chunk = result.units.slice(i, i + 500).map((u) => [
        caseId, versionId, u.kind, u.page || null, u.bbox ? JSON.stringify(u.bbox) : null, u.sheet || null,
        u.cell_ref || null, u.row_index || null, u.col_index || null, u.text == null ? null : String(u.text),
        u.formula || null, u.merged_range || null, u.number_format || null]);
      await cx.q('INSERT INTO uw_evidence_units (' + cols.join(', ') + ') VALUES ?', [chunk]);
    }
    const sets = ['extraction_status = ?', 'extraction_detail = ?', 'page_count = ?'];
    const args = [result.status, String(result.detail || '').slice(0, 500), result.pageCount || null];
    // Only overwrite the classification while it is still an unconfirmed
    // system suggestion — never an analyst's decision.
    if (suggestion && suggestion.docType !== 'unclassified') {
      sets.push("doc_type = IF(classification_confirmed = 0 AND classified_by = 'system', ?, doc_type)");
      args.push(suggestion.docType);
    }
    args.push(versionId);
    await cx.q('UPDATE uw_document_versions SET ' + sets.join(', ') + ' WHERE id = ?', args);
  });
}

async function runExtraction(versionId, caseId, type, buf, filename) {
  let result;
  try { result = await extract(type, buf); }
  catch (e) { result = { status: 'failed', detail: 'Extraction error: ' + String(e.message).slice(0, 300), units: [] }; }
  const text = result.units.filter((u) => u.kind === 'line').slice(0, 400).map((u) => u.text).join('\n')
    || result.units.filter((u) => u.kind === 'cell').slice(0, 400).map((u) => u.text || '').join(' ');
  const suggestion = classify.suggest({ filename, text });
  await saveExtraction(versionId, caseId, result, suggestion);
  return result;
}

/* Ingest one byte stream (an upload or a ZIP member). Appends to `report`. */
async function ingestOne(ctx, item, depth) {
  const { caseId, user, report, budget } = ctx;
  const name = item.path || item.originalName;
  const base = {
    originalName: String(name).split('/').pop() || 'file', title: String(name).split('/').pop() || 'file',
    source: item.source || 'upload', sourcePath: item.sourcePath || '', parentVersionId: item.parentVersionId || null, user
  };
  const entry = { name, sourcePath: base.sourcePath };

  // Unreadable ZIP members arrive without bytes.
  if (!item.buffer) {
    const row = Object.assign(base, {
      sha256: null, objectUri: null, mime: '', detectedType: 'unknown', sizeBytes: 0, scanStatus: 'not_scanned', scanDetail: '',
      intakeStatus: 'quarantined', quarantineReason: item.problem, recoverableAction: ingest.recoverableAction('zip', item.problem),
      extractionStatus: 'not_applicable'
    });
    const ids = await tx((cx) => insertVersion(cx, caseId, row, null));
    report.push(Object.assign(entry, ids, { intake: 'quarantined', reason: item.problem, action: row.recoverableAction }));
    return;
  }

  const buf = item.buffer;
  const detected = await ingest.detectType(buf, name);
  const scanned = ingest.scan(buf);
  const hash = store.sha256(buf);

  let intake = 'accepted', reason = '', action = '';
  if (scanned.status === 'infected') { intake = 'quarantined'; reason = 'Malware detected: ' + scanned.detail; }
  else if (detected.problem) { intake = 'quarantined'; reason = detected.problem; }
  else if (detected.type === 'ole') { intake = 'quarantined'; reason = 'Legacy .xls or password-protected Office file — cannot be read safely.'; }
  else if (detected.type === 'unknown') { intake = 'quarantined'; reason = 'Unsupported file type.'; }
  else if (detected.type === 'zip' && depth >= config.uw.zipMaxDepth) { intake = 'quarantined'; reason = 'Archive nested deeper than ' + config.uw.zipMaxDepth + ' level(s).'; }
  if (intake === 'quarantined') action = ingest.recoverableAction(detected.type, reason);

  // Same bytes already on this case: record the receipt, flag it, skip work.
  let duplicateOf = null;
  if (intake === 'accepted') {
    const dup = await q(
      "SELECT id FROM uw_document_versions WHERE case_id = ? AND sha256 = ? AND intake_status <> 'duplicate' ORDER BY id LIMIT 1", [caseId, hash]);
    if (dup.length) { intake = 'duplicate'; duplicateOf = dup[0].id; }
  }

  // Infected bytes are never kept; everything else is preserved as received.
  const stored = scanned.status === 'infected' ? null : store.put(buf);

  const row = Object.assign(base, {
    sha256: hash, objectUri: stored ? stored.uri : null, mime: detected.mime, detectedType: detected.type,
    sizeBytes: buf.length, scanStatus: scanned.status, scanDetail: scanned.detail,
    intakeStatus: intake, duplicateOfId: duplicateOf, quarantineReason: reason, recoverableAction: action,
    extractionStatus: intake === 'accepted' ? (detected.type === 'zip' ? 'not_applicable' : 'pending') : 'not_applicable'
  });
  const ids = await tx((cx) => insertVersion(cx, caseId, row, item.documentId || null));
  const out = Object.assign(entry, ids, { intake, detectedType: detected.type, sha256: hash, scan: scanned.status });
  if (reason) Object.assign(out, { reason, action });
  if (duplicateOf) out.duplicateOfVersionId = duplicateOf;
  report.push(out);

  if (intake !== 'accepted') return;

  if (detected.type === 'zip') {
    let members;
    try { members = await ingest.expandZip(buf, budget); }
    catch (e) {
      const msg = 'Archive rejected: ' + e.message;
      await q("UPDATE uw_document_versions SET intake_status = 'quarantined', quarantine_reason = ?, recoverable_action = ? WHERE id = ?",
        [msg.slice(0, 255), ingest.recoverableAction('zip', msg), ids.versionId]);
      out.intake = 'quarantined'; out.reason = msg; out.action = ingest.recoverableAction('zip', msg);
      return;
    }
    for (const m of members) {
      await ingestOne(ctx, {
        path: m.path, buffer: m.buffer, problem: m.problem, source: 'zip',
        sourcePath: (base.sourcePath ? base.sourcePath + ' › ' : base.originalName + ' › ') + m.path,
        parentVersionId: ids.versionId
      }, depth + 1);
    }
    return;
  }

  const result = await runExtraction(ids.versionId, caseId, detected.type, buf, name);
  out.extraction = result.status;
  if (result.detail) out.extractionDetail = result.detail;
  if (result.encrypted) {
    const msg = 'The PDF is password protected.';
    await q("UPDATE uw_document_versions SET intake_status = 'quarantined', quarantine_reason = ?, recoverable_action = ? WHERE id = ?",
      [msg, ingest.recoverableAction('pdf', msg), ids.versionId]);
    // A quarantined version must not stand as the document's current version.
    await q('UPDATE uw_documents SET current_version_id = NULL WHERE id = ? AND current_version_id = ?', [ids.documentId, ids.versionId]);
    out.intake = 'quarantined'; out.reason = msg; out.action = ingest.recoverableAction('pdf', msg);
  }
}

/* Ingest a batch: [{ originalName, buffer | path, documentId? }]. Files on disk
   are read one at a time, and the ZIP budget spans the whole batch. */
async function ingestBatch({ caseId, user, files, source = 'upload' }) {
  const ctx = { caseId, user, report: [], budget: { entries: 0, bytes: 0 } };
  for (const f of files) {
    const buffer = f.buffer || fs.readFileSync(f.path);
    await ingestOne(ctx, { path: f.originalName, buffer, source, documentId: f.documentId || null }, 0);
  }
  return ctx.report;
}

module.exports = { ingestBatch, runExtraction };
