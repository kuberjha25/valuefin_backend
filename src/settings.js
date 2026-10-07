'use strict';
/* Director-editable credit-policy configuration, held in app_settings, plus the
   graded investor list. Defaults come from policy.js so a fresh database works
   before anyone has saved anything. */
const { q } = require('./db/pool');
const policy = require('./policy');

const asObject = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
};

async function load(key) {
  const rows = await q('SELECT svalue FROM app_settings WHERE skey = ?', [key]);
  return rows.length ? asObject(rows[0].svalue) : null;
}
async function save(key, value, userName) {
  await q(
    `INSERT INTO app_settings (skey, svalue, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE svalue = VALUES(svalue), updated_by = VALUES(updated_by)`,
    [key, JSON.stringify(value), userName || '']);
}

async function getPolicy() {
  return Object.assign({}, policy.DEFAULT_POLICY, (await load('policy')) || {});
}
async function savePolicy(p, userName) { await save('policy', p, userName); return getPolicy(); }

/* Stored weights are merged onto the fixed component list, so a component can
   never go missing and an unknown key can never appear. */
async function getWeights() {
  const stored = (await load('weights')) || {};
  const out = policy.defaultWeights();
  policy.PRODUCT_KEYS.forEach((p) => {
    const have = Array.isArray(stored[p]) ? stored[p] : [];
    out[p] = out[p].map((c) => {
      const hit = have.find((r) => r.key === c.key);
      return hit && isFinite(+hit.weight) ? { ...c, weight: +hit.weight } : c;
    });
  });
  return out;
}
async function saveWeights(w, userName) { await save('weights', w, userName); return getWeights(); }

const GROUPS = ['common', ...policy.PRODUCT_KEYS];
async function getChecklists() {
  const stored = (await load('checklists')) || {};
  const out = policy.defaultChecklists();
  GROUPS.forEach((g) => { if (Array.isArray(stored[g])) out[g] = stored[g]; });
  return out;
}
async function saveChecklists(c, userName) { await save('checklists', c, userName); return getChecklists(); }

async function getInvestors() {
  const rows = await q('SELECT * FROM investors ORDER BY name');
  return rows.map((r) => ({ id: r.id, name: r.name, tier: r.tier }));
}
async function investorTierFor(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return 'neutral';
  const rows = await q('SELECT tier FROM investors WHERE LOWER(name) = ? LIMIT 1', [n]);
  return rows.length ? rows[0].tier : 'neutral';
}

module.exports = {
  GROUPS, getPolicy, savePolicy, getWeights, saveWeights, getChecklists, saveChecklists,
  getInvestors, investorTierFor, asObject
};
