'use strict';
/* Phase 1 underwriting API — mounted at /api/uw. */
const express = require('express');

const router = express.Router();
router.use(require('./cases'));
router.use(require('./documents'));
router.use(require('./analysis'));
router.use(require('./bank'));
router.use(require('./investigation'));
router.use(require('./workflow'));
router.use(require('./config'));

module.exports = router;
