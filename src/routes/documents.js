'use strict';
/* Documents — PDF upload into a per-borrower server folder, inline preview,
   and the maker→checker approval flow. */
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { q } = require('../db/pool');
const repo = require('../repo');
const auth = require('../auth');
const audit = require('../audit');
const { notify } = require('../notify');
const los = require('../los');
const { analysePdf } = require('../docanalysis');
const { H, bad, notFound, optStr, reqId, oneOf } = require('../http');

const router = express.Router();
const docstore = require('../docstore');
const { CATEGORIES, upload } = docstore;
const { CHECKLIST_KEYS } = require('../checklist');

const SELECT = repo.DOCUMENT_SELECT;

/* ---------------- list ---------------- */
router.get('/', H(async (req) => {
  auth.requireUser(req);
  const where = [], args = [];
  if (req.query.status) { where.push('d.status = ?'); args.push(oneOf(req.query.status, 'Status', ['pending', 'approved', 'rejected'])); }
  if (req.query.borrowerId) { where.push('d.borrower_id = ?'); args.push(reqId(req.query.borrowerId, 'Borrower')); }
  if (req.query.q) { where.push('(d.title LIKE ? OR d.filename LIKE ?)'); args.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  const sql = SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY d.id DESC LIMIT 500';
  const rows = await q(sql, args);
  return rows.map(repo.mapDocument);
}));

router.get('/counts', H(async (req) => {
  auth.requireUser(req);
  const rows = await q('SELECT status, COUNT(*) AS n FROM documents GROUP BY status');
  const out = { pending: 0, approved: 0, rejected: 0, total: 0 };
  rows.forEach((r) => { out[r.status] = +r.n; out.total += +r.n; });
  return out;
}));

/* ---------------- upload (mounted under /api/borrowers/:id/documents too) ---------------- */
const uploadHandler = (req, res, next) => {
  try { auth.requireWrite(req); } catch (e) { return next(e); }
  upload.single('file')(req, res, async (err) => {
    if (err) return next(Object.assign(err, { status: 400 }));
    try {
      const me = req.user;
      const borrowerId = reqId(req.params.id || req.body.borrowerId, 'Borrower');
      const b = await repo.getBorrower(borrowerId);
      if (!b) throw notFound('Borrower not found.');

      const f = docstore.assertPdf(req.file);
      const category = oneOf(req.body.category, 'Category', CATEGORIES, 'Other');
      const checklistKey = req.body.checklistKey ? oneOf(req.body.checklistKey, 'Checklist item', CHECKLIST_KEYS) : null;
      const title = optStr(req.body.title, 'Title') || f.originalname.replace(/\.pdf$/i, '');

      const doc = await docstore.saveDocument(q, { borrower: b, file: f, title, category, checklistKey, user: me });

      await notify({ toRole: 'director', type: 'upload', docId: doc.id, borrowerId, customerName: b.name,
        message: me.name + ' uploaded “' + title + '” for ' + b.name + ' — awaiting your review.' });
      await audit.log(req, 'document.upload', 'document', doc.id,
        me.name + ' uploaded “' + title + '” for ' + b.name, { category, checklistKey, size: f.size });

      res.json(await repo.getDocument(doc.id));
    } catch (e) { next(e); }
  });
};

router.post('/', uploadHandler);

/* ---------------- inline file stream ---------------- */
router.get('/:id/file', (req, res, next) => {
  Promise.resolve().then(async () => {
    auth.requireUser(req);
    const id = reqId(req.params.id, 'Document');
    const d = await repo.getDocument(id);
    if (!d || !d.relPath) throw notFound('Document not found.');

    // Resolve and confine to the data directory — a stored path must never
    // escape it, however it got into the row.
    const abs = path.resolve(config.paths.data, d.relPath);
    if (!abs.startsWith(path.resolve(config.paths.data) + path.sep)) throw notFound('Document not found.');
    if (!fs.existsSync(abs)) throw notFound('The file is missing from the server.');

    /* The SPA previews this stream in an iframe from a different port, which
       helmet's blanket X-Frame-Options: SAMEORIGIN forbids — the browser then
       reports it as "refused to connect". X-Frame-Options cannot name an
       allowed origin (ALLOW-FROM is obsolete), so drop it for this route only
       and pin the permitted embedders with CSP instead. */
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy',
      "frame-ancestors 'self' " + config.corsOrigin + '; sandbox allow-same-origin allow-scripts allow-popups');

    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', fs.statSync(abs).size);
    res.setHeader('Content-Disposition', disposition + '; filename="' + (d.filename || 'document.pdf').replace(/"/g, '') + '"');
    res.setHeader('Cache-Control', 'private, max-age=60');
    fs.createReadStream(abs).pipe(res);
  }).catch(next);
});

/* ---------------- read the document ----------------
   Pulls the text out of the PDF and, for a bank statement, summarises inflow,
   balance behaviour and anything that bounced. The result is stored on the
   document, so it is read once unless a re-read is asked for. */
router.post('/:id/analyse', H(async (req) => {
  const me = auth.requireUser(req);
  const id = reqId(req.params.id, 'Document');
  const d = await repo.getDocument(id, q, { full: true });
  if (!d || !d.relPath) throw notFound('Document not found.');
  if (d.analysis && !(req.query.refresh === '1' || req.query.refresh === 'true')) return d;

  const abs = path.resolve(config.paths.data, d.relPath);
  if (!abs.startsWith(path.resolve(config.paths.data) + path.sep) || !fs.existsSync(abs)) throw notFound('The file is missing from the server.');
  const analysis = await analysePdf(fs.readFileSync(abs), me);
  await q('UPDATE documents SET analysis = ? WHERE id = ?', [JSON.stringify(analysis), id]);
  await audit.log(req, 'document.analyse', 'document', id,
    me.name + ' read “' + d.title + '” — ' + (analysis.kind === 'bank_statement' ? analysis.transactionCount + ' transaction(s)' : 'no statement rows recognised'),
    { kind: analysis.kind, pages: analysis.pages, source: analysis.source });
  return repo.getDocument(id, q, { full: true });
}));

/* ---------------- approve / reject ---------------- */
router.post('/:id/decide', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Document');
  const d = await repo.getDocument(id);
  if (!d) throw notFound('Document not found.');
  if (d.status !== 'pending') throw bad('This document was already ' + d.status + '.');
  // Maker ≠ checker, but only when there is in fact another Director to ask;
  // a single-Director desk would otherwise deadlock on its own uploads.
  if (d.uploadedById === me.id) {
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM users WHERE role = 'director' AND active = 1 AND id <> ?", [me.id]);
    if (n > 0) throw bad('You uploaded this document — another Director has to review it.');
  }

  const approve = req.body.approve === true || req.body.approve === 'true';
  const reason = optStr(req.body.reason, 'Reason', { max: 500 });
  if (!approve && !reason) throw bad('A reason is required when rejecting.');

  const status = approve ? 'approved' : 'rejected';
  await q('UPDATE documents SET status = ?, decided_by = ?, decided_at = NOW(3), reason = ? WHERE id = ?',
    [status, me.name, reason, id]);

  if (d.uploadedById) {
    await notify({ toUserId: d.uploadedById, type: 'decision', docId: id, borrowerId: d.borrowerId, customerName: d.borrowerName,
      message: 'Your document “' + d.title + '” for ' + d.borrowerName + ' was ' + status + (reason ? ': ' + reason : '') + '.' });
  }
  await audit.log(req, 'document.' + status, 'document', id,
    me.name + ' ' + status + ' “' + d.title + '” for ' + d.borrowerName, { reason });
  // A rejected checklist document puts its row back to pending, which can park the application again.
  if (d.applicationId) await los.refreshStage(d.applicationId);

  return repo.getDocument(id);
}));

/* ---------------- delete ---------------- */
router.delete('/:id', H(async (req) => {
  const me = auth.requireWrite(req);
  const id = reqId(req.params.id, 'Document');
  const d = await repo.getDocument(id);
  if (!d) throw notFound('Document not found.');
  // Uploaders may withdraw their own pending upload; anything decided, or
  // anyone else's, is the Director's to remove.
  const ownPending = d.status === 'pending' && d.uploadedById === me.id;
  if (!ownPending && me.role !== 'director') {
    throw Object.assign(new Error('Only the Director can delete a reviewed document, or one uploaded by someone else.'), { status: 403 });
  }

  await q('DELETE FROM documents WHERE id = ?', [id]);
  try {
    const abs = path.resolve(config.paths.data, d.relPath || '');
    if (abs.startsWith(path.resolve(config.paths.data) + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (e) { console.error('[documents] could not remove file:', e.message); }

  await audit.log(req, 'document.delete', 'document', id, me.name + ' deleted “' + d.title + '” (' + d.borrowerName + ')');
  if (d.applicationId) await los.refreshStage(d.applicationId);
  return { ok: true };
}));

module.exports = { router, uploadHandler, CATEGORIES };
