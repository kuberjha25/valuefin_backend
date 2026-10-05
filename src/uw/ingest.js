'use strict';
/* ============================================================================
   Ingestion checks (spec §2.2, §4): type detection from the bytes themselves,
   malware scanning, and safe ZIP expansion with depth / count / size /
   decompression-ratio limits. Nothing here touches the database.
   ========================================================================== */
const { spawnSync } = require('child_process');
const yauzl = require('yauzl');
const config = require('../config');

const MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  zip: 'application/zip',
  ole: 'application/x-ole-storage',
  png: 'image/png', jpeg: 'image/jpeg', tiff: 'image/tiff'
};

const startsWith = (buf, bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

/* Open a buffer as a ZIP and list entries without inflating them. */
function listZip(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on('entry', (e) => { entries.push(e); if (entries.length > 100000) { zip.close(); reject(new Error('Too many archive entries')); } else zip.readEntry(); });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/* Decide what a file really is from its bytes. The declared MIME type and the
   extension are only used to tell CSV apart from other plain text. */
async function detectType(buf, name) {
  if (!buf || !buf.length) return { type: 'unknown', mime: '', problem: 'The file is empty.' };
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { type: 'pdf', mime: MIME.pdf };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: 'image', mime: MIME.png };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { type: 'image', mime: MIME.jpeg };
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return { type: 'image', mime: MIME.tiff };
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { type: 'ole', mime: MIME.ole };
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) {
    let entries;
    try { entries = await listZip(buf); }
    catch (e) { return { type: 'zip', mime: MIME.zip, problem: 'The archive could not be read (' + e.message + ').' }; }
    const names = new Set(entries.map((e) => e.fileName));
    if (names.has('[Content_Types].xml') && names.has('xl/workbook.xml')) {
      // An XLSX is itself a ZIP: hold it to the same decompression limits
      // before any spreadsheet library inflates it.
      const total = entries.reduce((s, e) => s + e.uncompressedSize, 0);
      const packed = entries.reduce((s, e) => s + e.compressedSize, 0);
      if (entries.some((e) => e.isEncrypted())) return { type: 'xlsx', mime: MIME.xlsx, problem: 'The workbook is encrypted.' };
      if (total > config.uw.zipMaxTotalBytes || (packed > 0 && total / packed > config.uw.zipMaxRatio)) {
        return { type: 'xlsx', mime: MIME.xlsx, problem: 'The workbook expands beyond the safe decompression limit.' };
      }
      return { type: 'xlsx', mime: MIME.xlsx };
    }
    if (names.has('[Content_Types].xml')) {
      return { type: 'unknown', mime: 'application/vnd.openxmlformats', problem: 'Office document other than an .xlsx workbook (e.g. .docx/.pptx) is not supported.' };
    }
    return { type: 'zip', mime: MIME.zip };
  }
  if (/\.csv$/i.test(name || '')) {
    const sample = buf.subarray(0, Math.min(buf.length, 65536));
    if (sample.includes(0x00)) return { type: 'unknown', mime: '', problem: 'The file is named .csv but contains binary data.' };
    return { type: 'csv', mime: MIME.csv };
  }
  return { type: 'unknown', mime: '', problem: 'Unsupported file type.' };
}

/* What the user can do about a quarantined file. */
function recoverableAction(type, problem) {
  if (type === 'ole') return 'Re-save the file as an unencrypted .xlsx (Excel 2007+) or export it to PDF, then upload it again.';
  if (/encrypt|password/i.test(problem || '')) return 'Ask the borrower for an unprotected copy, or remove the password, then upload it again.';
  if (type === 'zip') return 'Re-create the archive (standard ZIP, no encryption, no nested archives beyond the limit) or upload the files individually.';
  if (/malware|infected/i.test(problem || '')) return 'Do not open the file. Ask the borrower to send a clean copy through a different channel.';
  return 'Convert to PDF, XLSX, CSV, PNG, JPEG or TIFF and upload it again.';
}

/* Optional ClamAV scan. Without a configured scanner the file is recorded as
   "not scanned" — never as clean. */
function scan(buf) {
  if (!config.uw.clamscanPath) return { status: 'not_scanned', detail: 'No malware scanner configured (set UW_CLAMSCAN_PATH).' };
  try {
    const r = spawnSync(config.uw.clamscanPath, ['--no-summary', '--stdout', '-'], { input: buf, timeout: 120000, maxBuffer: 1024 * 1024 });
    if (r.error) return { status: 'error', detail: r.error.message.slice(0, 250) };
    if (r.status === 0) return { status: 'clean', detail: '' };
    if (r.status === 1) return { status: 'infected', detail: String(r.stdout || '').trim().slice(0, 250) || 'Malware detected' };
    return { status: 'error', detail: String(r.stderr || r.stdout || 'scanner exit ' + r.status).trim().slice(0, 250) };
  } catch (e) {
    return { status: 'error', detail: e.message.slice(0, 250) };
  }
}

const isJunk = (name) => /(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name) || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name);
const S_IFMT = 0o170000, S_IFLNK = 0o120000;

/* Expand a ZIP one entry at a time. `budget` is shared across nested archives
   so the limits apply to the whole upload, not to each level separately.
   Resolves to [{ path, buffer }] or [{ path, buffer: null, problem }]. */
function expandZip(buf, budget) {
  const L = config.uw;
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      const out = [];
      let failed = false;
      const fail = (e) => { if (!failed) { failed = true; try { zip.close(); } catch (_) { /* already closed */ } reject(e); } };

      zip.on('error', fail);
      zip.on('end', () => { if (!failed) resolve(out); });
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        if (/\/$/.test(name) || isJunk(name)) return zip.readEntry();

        budget.entries += 1;
        if (budget.entries > L.zipMaxEntries) return fail(new Error('more than ' + L.zipMaxEntries + ' files in the archive'));

        const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
        if (mode === S_IFLNK) { out.push({ path: name, buffer: null, problem: 'Symbolic link inside the archive.' }); return zip.readEntry(); }
        if (entry.isEncrypted()) { out.push({ path: name, buffer: null, problem: 'Encrypted archive entry — contents cannot be read.' }); return zip.readEntry(); }
        if (entry.uncompressedSize > L.zipMaxEntryBytes) {
          out.push({ path: name, buffer: null, problem: 'Entry exceeds the ' + Math.round(L.zipMaxEntryBytes / 1048576) + ' MB per-file limit.' });
          return zip.readEntry();
        }
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > L.zipMaxRatio) {
          return fail(new Error('suspicious compression ratio on "' + name + '" (possible decompression bomb)'));
        }
        budget.bytes += entry.uncompressedSize;
        if (budget.bytes > L.zipMaxTotalBytes) return fail(new Error('archive expands beyond ' + Math.round(L.zipMaxTotalBytes / 1048576) + ' MB'));

        zip.openReadStream(entry, (e, stream) => {
          if (e) { out.push({ path: name, buffer: null, problem: 'Entry could not be read (' + e.message + ').' }); return zip.readEntry(); }
          const chunks = [];
          let size = 0;
          stream.on('data', (c) => {
            size += c.length;
            if (size > L.zipMaxEntryBytes) { stream.destroy(new Error('entry larger than declared')); return; }
            chunks.push(c);
          });
          stream.on('error', (se) => fail(new Error('"' + name + '": ' + se.message)));
          stream.on('end', () => { out.push({ path: name, buffer: Buffer.concat(chunks) }); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { detectType, recoverableAction, scan, expandZip, listZip, MIME };
