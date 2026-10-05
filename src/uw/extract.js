'use strict';
/* ============================================================================
   Document extraction (spec §2.3, §4).

   * PDF   — native text layer first, line by line, with each line's bounding
             box on its page. Pages without a text layer are reported as
             needing OCR; nothing is guessed for them.
   * XLSX  — every non-empty cell with workbook/sheet/cell coordinates, the
             cached value, the formula text, number format and merged range.
   * CSV   — every non-empty cell with row/column coordinates.
   * Image — needs OCR. No OCR service is configured in Phase 1, so the file
             is marked "OCR required" and routed to the analyst.

   Pure functions over a Buffer: they return { status, detail, pageCount, units }
   and the caller persists them.
   ========================================================================== */
const ExcelJS = require('exceljs');
const config = require('../config');
const { numberToDecimalString } = require('./money');

const MIN_PAGE_CHARS = 20;          // fewer printable characters than this = no usable text layer
const MAX_UNITS = 250000;

let pdfjsPromise = null;
const pdfjs = () => (pdfjsPromise = pdfjsPromise || import('pdfjs-dist/legacy/build/pdf.mjs'));

const r4 = (n) => Math.round(n * 10000) / 10000;

/* ---------------- PDF ---------------- */
async function extractPdf(buf) {
  const lib = await pdfjs();
  let doc;
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true,
      useSystemFonts: false, verbosity: 0, stopAtErrors: false
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') {
      return { status: 'unreadable', detail: 'The PDF is password protected.', encrypted: true, units: [] };
    }
    return { status: 'unreadable', detail: 'The PDF could not be opened (' + String(e && e.message || e).slice(0, 200) + ').', units: [] };
  }

  try {
    const pageCount = doc.numPages;
    if (pageCount > config.uw.maxPdfPages) {
      return { status: 'failed', detail: 'The PDF has ' + pageCount + ' pages; the limit is ' + config.uw.maxPdfPages + '. Split it and upload the parts.', pageCount, units: [] };
    }
    const units = [];
    const noText = [];
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => typeof it.str === 'string' && it.str.length);
      const chars = items.reduce((n, it) => n + it.str.replace(/\s/g, '').length, 0);
      if (chars < MIN_PAGE_CHARS) { noText.push(p); page.cleanup(); continue; }

      // Group text items into lines by baseline, top of page first.
      const rows = items.map((it) => ({
        str: it.str, x: it.transform[4], y: it.transform[5],
        w: it.width || 0, h: it.height || Math.abs(it.transform[3]) || 0
      })).sort((a, b) => (Math.abs(b.y - a.y) > 0.5 ? b.y - a.y : a.x - b.x));

      const lines = [];
      for (const it of rows) {
        const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, Math.min(l.h, it.h || l.h) * 0.5));
        if (line) { line.items.push(it); line.h = Math.max(line.h, it.h); }
        else lines.push({ y: it.y, h: it.h, items: [it] });
      }
      lines.sort((a, b) => b.y - a.y);
      for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
        let text = '';
        let lastEnd = null;
        for (const it of line.items) {
          if (lastEnd != null && it.x - lastEnd > 1.5 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
          text += it.str;
          lastEnd = it.x + it.w;
        }
        text = text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const x0 = Math.min(...line.items.map((i) => i.x));
        const x1 = Math.max(...line.items.map((i) => i.x + i.w));
        const top = vp.height - (line.y + line.h);
        units.push({
          kind: 'line', page: p, text,
          bbox: { x: r4(x0 / vp.width), y: r4(Math.max(0, top) / vp.height), w: r4((x1 - x0) / vp.width), h: r4(line.h / vp.height) }
        });
        if (units.length > MAX_UNITS) return { status: 'failed', detail: 'Too much text to index.', pageCount, units: [] };
      }
      page.cleanup();
    }
    let status = 'done';
    let detail = '';
    if (noText.length === pageCount) { status = 'ocr_required'; detail = 'No text layer on any page — this is a scan and needs OCR.'; }
    else if (noText.length) detail = 'No text layer on page(s) ' + compactList(noText) + ' — those pages need OCR.';
    return { status, detail, pageCount, units, ocrPages: noText };
  } finally {
    await doc.destroy();
  }
}

function compactList(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? String(nums[i]) : nums[i] + '–' + nums[j]);
    i = j;
  }
  return out.join(', ');
}

/* ---------------- spreadsheet helpers ---------------- */
function colLetters(n) {          // 1 -> A
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function scalarText(v) {
  if (v == null) return null;
  if (typeof v === 'number') return numberToDecimalString(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text || '').join('');
    if (v.error) return String(v.error);
    if (v.text != null) return typeof v.text === 'string' ? v.text : scalarText(v.text);
  }
  return String(v);
}

/* ---------------- XLSX ---------------- */
async function extractXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); }
  catch (e) { return { status: 'unreadable', detail: 'The workbook could not be read (' + String(e.message).slice(0, 200) + ').', units: [] }; }

  const units = [];
  let noCache = 0;
  for (const ws of wb.worksheets) {
    const masterOf = {};
    for (const range of (ws.model && ws.model.merges) || []) {
      const master = String(range).split(':')[0];
      masterOf[master] = String(range);
    }
    let overflow = false;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (overflow) return;
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (overflow) return;
        if (cell.type === ExcelJS.ValueType.Merge) return;     // value lives on the master cell
        const v = cell.value;
        let text = null;
        let formula = null;
        if (v && typeof v === 'object' && (v.formula != null || v.sharedFormula != null)) {
          formula = cell.formula || v.formula || null;
          text = v.result === undefined ? null : scalarText(v.result);
          if (v.result === undefined) noCache++;
        } else {
          text = scalarText(v);
        }
        if ((text == null || text === '') && !formula) return;
        const ref = colLetters(colNumber) + rowNumber;
        units.push({
          kind: 'cell', sheet: String(ws.name).slice(0, 100), cell_ref: ref, row_index: rowNumber, col_index: colNumber,
          text, formula, merged_range: masterOf[ref] || null,
          number_format: cell.numFmt ? String(cell.numFmt).slice(0, 64) : null
        });
        if (units.length > config.uw.maxSheetCells) overflow = true;
      });
    });
    if (overflow) {
      return { status: 'failed', detail: 'The workbook has more than ' + config.uw.maxSheetCells + ' filled cells. Split it or remove unused sheets.', units: [] };
    }
  }
  const detail = noCache
    ? noCache + ' formula cell(s) have no saved value (the file was saved without recalculating). Open and re-save it in Excel to capture them.'
    : '';
  return { status: units.length ? 'done' : 'unreadable', detail: units.length ? detail : 'The workbook has no filled cells.', units, sheetCount: wb.worksheets.length };
}

/* ---------------- CSV ---------------- */
function decodeText(buf) {
  let b = buf;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), note: '' }; }
  catch (_) { return { text: new TextDecoder('windows-1252').decode(b), note: 'Not valid UTF-8 — read as Windows-1252.' }; }
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.filter((c) => c === counts[0]).length;
    const score = consistent * 100 + counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/* RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text, delim) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"' && field === '') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function extractCsv(buf) {
  const { text, note } = decodeText(buf);
  const delim = detectDelimiter(text);
  const rows = parseCsv(text, delim);
  const units = [];
  rows.forEach((r, ri) => r.forEach((v, ci) => {
    if (v === '') return;
    units.push({ kind: 'cell', sheet: 'CSV', cell_ref: colLetters(ci + 1) + (ri + 1), row_index: ri + 1, col_index: ci + 1, text: v.slice(0, 60000) });
  }));
  if (units.length > config.uw.maxSheetCells) {
    return { status: 'failed', detail: 'The CSV has more than ' + config.uw.maxSheetCells + ' filled cells.', units: [] };
  }
  const delimName = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[delim];
  return {
    status: units.length ? 'done' : 'unreadable',
    detail: units.length ? [note, delimName + '-separated, ' + rows.length + ' row(s)'].filter(Boolean).join(' ') : 'The CSV is empty.',
    units
  };
}

async function extract(type, buf) {
  if (type === 'pdf') return extractPdf(buf);
  if (type === 'xlsx') return extractXlsx(buf);
  if (type === 'csv') return extractCsv(buf);
  if (type === 'image') return { status: 'ocr_required', detail: 'Image — needs OCR. No OCR service is configured in Phase 1; read it manually and record facts with page references.', units: [] };
  return { status: 'not_applicable', detail: '', units: [] };
}

module.exports = { extract, extractPdf, extractXlsx, extractCsv, parseCsv, colLetters };
