'use strict';
/* Credit-policy configuration. Everyone can read it — it explains the gates an
   application is measured against — and only a Director can change it. A change
   applies to the next policy run; a check already on a file keeps its snapshot. */
const express = require('express');
const { q } = require('../db/pool');
const auth = require('../auth');
const audit = require('../audit');
const policy = require('../policy');
const settings = require('../settings');
const { H, bad, notFound, reqStr, reqNum, reqId, oneOf, flag } = require('../http');

const router = express.Router();

router.get('/', H(async (req) => {
  auth.requireUser(req);
  const [pol, weights, checklists] = await Promise.all([settings.getPolicy(), settings.getWeights(), settings.getChecklists()]);
  return { policy: pol, catalogue: policy.catalogue(), docChecklist: checklists, scoreWeights: weights };
}));

router.put('/policy', H(async (req) => {
  const me = auth.requireDirector(req);
  const b = req.body || {};
  const next = {
    policyVersion: reqStr(b.policyVersion, 'Policy version', { max: 20 }),
    penalDefault: reqNum(b.penalDefault, 'Penal spread', { min: 0, max: 100 }),
    gstPct: reqNum(b.gstPct, 'GST', { min: 0, max: 100 }),
    nof: reqNum(b.nof, 'Net Owned Funds', { min: 0, max: 1e14 }),
    vcCapWarnPct: reqNum(b.vcCapWarnPct, 'VC deviation band', { min: 0, max: 100 }),
    vcCapMaxPct: reqNum(b.vcCapMaxPct, 'VC hard stop', { min: 0, max: 100 }),
    vcCapMinBook: reqNum(b.vcCapMinBook, 'Activation floor', { min: 0, max: 1e14 })
  };
  if (next.vcCapMaxPct < next.vcCapWarnPct) throw bad('The VC hard stop cannot sit below the deviation band.');
  const before = await settings.getPolicy();
  const saved = await settings.savePolicy(next, me.name);
  await audit.log(req, 'settings.policy', 'settings', 'policy', me.name + ' saved the credit-policy defaults (v' + saved.policyVersion + ')',
    { from: before, to: saved });
  return saved;
}));

/* ---------------- document checklists ---------------- */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';

router.post('/checklist/:group', H(async (req) => {
  const me = auth.requireDirector(req);
  const group = oneOf(req.params.group, 'Checklist', settings.GROUPS);
  const label = reqStr(req.body.label, 'Label', { max: 190 });
  const lists = await settings.getChecklists();
  if (lists[group].some((r) => r.label.toLowerCase() === label.toLowerCase())) throw bad('That row is already on the list.');
  let key = 'x-' + slug(label), n = 2;
  while (lists[group].some((r) => r.key === key)) key = 'x-' + slug(label) + '-' + n++;
  lists[group].push({ key, label, mandatory: req.body.mandatory === undefined ? true : flag(req.body.mandatory) });
  await settings.saveChecklists(lists, me.name);
  await audit.log(req, 'settings.checklist.add', 'settings', group, me.name + ' added “' + label + '” to the ' + group + ' checklist');
  return { ok: true, key };
}));

router.delete('/checklist/:group/:key', H(async (req) => {
  const me = auth.requireDirector(req);
  const group = oneOf(req.params.group, 'Checklist', settings.GROUPS);
  const lists = await settings.getChecklists();
  const row = lists[group].find((r) => r.key === req.params.key);
  if (!row) throw notFound('That row is not on the checklist.');
  lists[group] = lists[group].filter((r) => r.key !== row.key);
  await settings.saveChecklists(lists, me.name);
  await audit.log(req, 'settings.checklist.remove', 'settings', group, me.name + ' removed “' + row.label + '” from the ' + group + ' checklist');
  return { ok: true };
}));

/* ---------------- scorecard weights ---------------- */
router.put('/weights', H(async (req) => {
  const me = auth.requireDirector(req);
  const before = await settings.getWeights();
  const next = {};
  policy.PRODUCT_KEYS.forEach((p) => {
    const rows = (req.body || {})[p];
    if (!Array.isArray(rows)) throw bad('Weights for ' + policy.PRODUCTS[p].name + ' are missing.');
    next[p] = before[p].map((c) => {
      const hit = rows.find((r) => r.key === c.key);
      if (!hit) throw bad('The ' + c.label + ' weight for ' + policy.PRODUCTS[p].name + ' is missing.');
      return { ...c, weight: reqNum(hit.weight, c.label + ' weight', { min: 0, max: 100 }) };
    });
  });
  const saved = await settings.saveWeights(next, me.name);
  await audit.log(req, 'settings.weights', 'settings', 'weights', me.name + ' saved the scorecard weights', { from: before, to: saved });
  return saved;
}));

/* ---------------- investor tiers ---------------- */
const TIERS = ['1', '2', 'neutral'];

router.get('/investors', H(async (req) => {
  auth.requireUser(req);
  return settings.getInvestors();
}));

router.post('/investors', H(async (req) => {
  const me = auth.requireDirector(req);
  const name = reqStr(req.body.name, 'Fund name', { max: 190 });
  const tier = oneOf(String(req.body.tier == null ? 'neutral' : req.body.tier), 'Tier', TIERS, 'neutral');
  const r = await q('INSERT INTO investors (name, tier) VALUES (?, ?)', [name, tier]);
  await audit.log(req, 'investor.create', 'investor', r.insertId, me.name + ' added the fund ' + name + ' (' + tier + ')');
  return { id: r.insertId, name, tier };
}));

router.put('/investors/:id', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Fund');
  const tier = oneOf(String(req.body.tier), 'Tier', TIERS);
  const rows = await q('SELECT * FROM investors WHERE id = ?', [id]);
  if (!rows.length) throw notFound('Fund not found.');
  await q('UPDATE investors SET tier = ? WHERE id = ?', [tier, id]);
  await audit.log(req, 'investor.tier', 'investor', id, me.name + ' graded ' + rows[0].name + ' as ' + tier, { from: rows[0].tier, to: tier });
  return { id, name: rows[0].name, tier };
}));

router.delete('/investors/:id', H(async (req) => {
  const me = auth.requireDirector(req);
  const id = reqId(req.params.id, 'Fund');
  const rows = await q('SELECT * FROM investors WHERE id = ?', [id]);
  if (!rows.length) throw notFound('Fund not found.');
  await q('DELETE FROM investors WHERE id = ?', [id]);
  await audit.log(req, 'investor.delete', 'investor', id, me.name + ' removed the fund ' + rows[0].name);
  return { ok: true };
}));

module.exports = router;
