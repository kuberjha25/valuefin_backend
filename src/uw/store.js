'use strict';
/* ============================================================================
   Immutable original store (spec §2.2, §3).

   Every accepted byte stream is written once, under its own SHA-256, and made
   read-only. Nothing in the application ever opens these files for writing
   again, so a reference to a version is a reference to exactly those bytes.
   ========================================================================== */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

function objectPath(hash) {
  if (!HEX64.test(hash)) throw new Error('Invalid object hash');
  return path.join(config.paths.evidence, hash.slice(0, 2), hash.slice(2, 4), hash);
}

/* Store bytes; idempotent for identical content. Returns { sha256, uri }. */
function put(buf) {
  const hash = sha256(buf);
  const abs = objectPath(hash);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.writeFileSync(abs, buf, { flag: 'wx', mode: 0o444 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Same name means same SHA-256; a size mismatch would mean the stored copy
    // was tampered with or truncated, which must not pass silently.
    if (fs.statSync(abs).size !== buf.length) throw new Error('Evidence store integrity error for ' + hash);
  }
  return { sha256: hash, uri: 'cas://sha256/' + hash };
}

function hashFromUri(uri) {
  const m = /^cas:\/\/sha256\/([0-9a-f]{64})$/.exec(String(uri || ''));
  return m ? m[1] : null;
}

function pathForUri(uri) {
  const hash = hashFromUri(uri);
  return hash ? objectPath(hash) : null;
}

/* Read and re-verify. A stored object that no longer hashes to its name is
   reported, never served. */
function read(uri) {
  const abs = pathForUri(uri);
  if (!abs || !fs.existsSync(abs)) throw Object.assign(new Error('The original file is missing from the evidence store.'), { status: 404 });
  const buf = fs.readFileSync(abs);
  if (sha256(buf) !== hashFromUri(uri)) throw Object.assign(new Error('The stored original failed its integrity check.'), { status: 500 });
  return buf;
}

module.exports = { sha256, put, read, pathForUri, hashFromUri };
