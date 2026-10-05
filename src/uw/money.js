'use strict';
/* ============================================================================
   Exact money and decimal arithmetic for underwriting (spec §3: "store amounts
   in integer paise or exact decimal").

   Everything here works on decimal *strings* and BigInt, never on binary
   floating point, so "12,34,567.89 in lakhs" becomes exactly the paise it
   says. Division (ratios) is done in BigInt to a fixed scale with explicit
   half-away-from-zero rounding.
   ========================================================================== */

/* Multipliers from a source unit to rupees. */
const UNIT_SCALE = {
  INR: 1n,
  INR_thousands: 1000n,
  INR_lakhs: 100000n,
  INR_millions: 1000000n,
  INR_crores: 10000000n
};
const UNITS = Object.keys(UNIT_SCALE);

/* Largest paise value we accept: safely inside 2^53 so a BIGINT read back by
   mysql2 as a JS number is still exact (≈ ₹90 lakh crore). */
const MAX_SAFE_PAISE = BigInt(Number.MAX_SAFE_INTEGER);

/* Parse a human or spreadsheet number into { neg, digits, scale } where the
   value is digits / 10^scale. Accepts Indian and Western grouping, a leading
   currency marker, a leading sign, and accountancy parentheses for negatives.
   Returns null if the text is not a plain number — never guesses. */
function parseDecimal(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/^(₹|rs\.?|inr)\s*/i, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) { s = s.slice(1).trim(); }
  s = s.replace(/^(₹|rs\.?|inr)\s*/i, '');
  // Grouping separators: commas, spaces, and the thin/no-break spaces that
  // PDFs and spreadsheets insert.
  s = s.replace(/[,\s   ]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const [intPart, fracPart = ''] = s.split('.');
  const digits = BigInt((intPart || '0') + fracPart);
  return { neg: neg && digits !== 0n, digits, scale: fracPart.length };
}

/* Integer division rounding half away from zero. */
function divRound(n, d) {
  if (d === 0n) throw new Error('division by zero');
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;
  return neg ? -q : q;
}

/* raw text + unit -> { paise: BigInt, rounded: bool } or null when unparsable. */
function toPaise(raw, unit = 'INR') {
  const p = parseDecimal(raw);
  if (!p) return null;
  const scale = UNIT_SCALE[unit];
  if (!scale) throw new Error('Unknown unit ' + unit);
  const numer = p.digits * scale * 100n;
  const denom = 10n ** BigInt(p.scale);
  let paise = divRound(numer, denom);
  const rounded = numer % denom !== 0n;
  if (p.neg) paise = -paise;
  return { paise, rounded };
}

/* Same as toPaise but returns a JS number and enforces the safe range. */
function paiseNumber(raw, unit, label = 'Amount') {
  const r = toPaise(raw, unit);
  if (!r) return { error: label + ' "' + String(raw).slice(0, 40) + '" is not a plain number.' };
  if (r.paise > MAX_SAFE_PAISE || r.paise < -MAX_SAFE_PAISE) return { error: label + ' is too large.' };
  return { paise: Number(r.paise), rounded: r.rounded };
}

/* Spreadsheet cells arrive as JS numbers. Number#toString gives the shortest
   decimal that round-trips, which is what the file stored; exponent forms are
   expanded so parseDecimal can read them. */
function numberToDecimalString(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  const s = String(n);
  if (!/e/i.test(s)) return s;
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return null;
  const [, sign, lead, frac = '', expS] = m;
  const exp = parseInt(expS, 10);
  const digits = lead + frac;
  if (exp >= 0) {
    const pointAt = 1 + exp;
    return sign + (digits.length <= pointAt ? digits + '0'.repeat(pointAt - digits.length)
      : digits.slice(0, pointAt) + '.' + digits.slice(pointAt));
  }
  return sign + '0.' + '0'.repeat(-exp - 1) + digits;
}

/* paise (number or BigInt) -> "1234.56" (no grouping) */
function paiseToRupeeString(paise) {
  const b = BigInt(paise);
  const neg = b < 0n;
  const a = neg ? -b : b;
  const r = (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0');
  return (neg ? '-' : '') + r;
}

/* Fixed-point value: BigInt `units` meaning units / 10^scale. */
const SCALE6 = 6;
function toMicro(raw) {
  const p = parseDecimal(raw);
  if (!p) return null;
  const v = p.scale <= SCALE6
    ? p.digits * 10n ** BigInt(SCALE6 - p.scale)
    : divRound(p.digits, 10n ** BigInt(p.scale - SCALE6));
  return p.neg ? -v : v;
}
const paiseToMicro = (paise) => BigInt(paise) * 10000n;   // 1 paisa = 0.01 rupee = 10^4 micro-rupees

/* BigInt fixed-point (value / 10^scale) -> decimal string */
function fixedToString(v, scale) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(scale);
  const whole = (a / base).toString();
  const frac = scale ? '.' + (a % base).toString().padStart(scale, '0') : '';
  return (neg ? '-' : '') + whole + frac;
}

/* (num / den) * mult, both micro-scaled BigInts, to `scale` decimals as a string. */
function ratioString(numMicro, denMicro, mult = 1n, scale = 10) {
  const q = divRound(numMicro * BigInt(mult) * 10n ** BigInt(scale), denMicro);
  return fixedToString(q, scale);
}

module.exports = {
  UNITS, UNIT_SCALE, MAX_SAFE_PAISE, parseDecimal, divRound, toPaise, paiseNumber,
  numberToDecimalString, paiseToRupeeString, toMicro, paiseToMicro, fixedToString, ratioString, SCALE6
};
