'use strict';
/* ============================================================================
   Document storage — the one place that turns an uploaded buffer into a file on
   disk plus a `documents` row. Shared by the standalone upload route and by
   borrower onboarding, so both enforce identical rules.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('./config');
const { bad } = require('./http');

const CATEGORIES = ['KYC', 'Financials', 'Sanction', 'Security', 'Invoice', 'PO', 'Bank statement', 'Other'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploadMaxBytes, files: 1 }
});

/* A PDF starts with "%PDF-". Checking the bytes stops a renamed .exe getting in
   where the declared mimetype alone would not. */
const looksLikePdf = (buf) => !!buf && buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-';

function assertPdf(file) {
  if (!file) throw bad('Attach a PDF to upload.');
  const named = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
  if (!named || !looksLikePdf(file.buffer)) throw bad('Only genuine PDF files are accepted.');
  return file;
}

/* Write the file into the borrower's folder and insert its row.
   `run` is either the pool's q() or a transaction's cx.q(). Returns the new
   document id plus the absolute path written, so a caller whose transaction
   later rolls back can remove the orphaned file. */
async function saveDocument(run, { borrower, application, file, title, category, checklistKey, docKey, user }) {
  assertPdf(file);

  /* Before sanction a document belongs to the application and lives in its own
     folder (the leading underscore keeps it clear of every borrower slug);
     at sanction the row is re-pointed at the borrower and the file stays put. */
  const folderName = borrower ? borrower.slug : path.posix.join('_applications', application.appCode);
  const folder = path.join(config.paths.customers, ...folderName.split('/'));
  fs.mkdirSync(folder, { recursive: true });

  const safe = file.originalname.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  const stored = Date.now() + '-' + (safe || 'document') + '.pdf';
  const abs = path.join(folder, stored);
  const relPath = path.posix.join('customers', folderName, stored);

  fs.writeFileSync(abs, file.buffer);
  try {
    const r = await run(
      `INSERT INTO documents (borrower_id, application_id, doc_key, title, filename, stored_name, rel_path, size_bytes,
                              category, checklist_key, uploaded_by_id, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [borrower ? borrower.id : null, application ? application.id : null, docKey || null, title,
        file.originalname.slice(0, 255), stored, relPath, file.size, category,
        checklistKey || null, user.id, user.name]);
    return { id: r.insertId, abs, relPath, title, category, checklistKey: checklistKey || null };
  } catch (e) {
    try { fs.unlinkSync(abs); } catch (_) { /* nothing written */ }
    throw e;
  }
}

/* Best-effort removal, used when a surrounding transaction rolls back. */
function discardFile(abs) {
  try { if (abs && fs.existsSync(abs)) fs.unlinkSync(abs); }
  catch (e) { console.error('[docstore] could not remove orphaned file:', e.message); }
}

module.exports = { CATEGORIES, upload, looksLikePdf, assertPdf, saveDocument, discardFile };
