'use strict';

const express = require('express');
const { timingSafeEqual } = require('node:crypto');

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Operational endpoints (not part of the public API):
 *   GET /livez    process is alive           (liveness probe, no dependencies)
 *   GET /health   dependency-aware health    (readiness probe, Docker HEALTHCHECK, status page)
 *   GET /metrics  Prometheus exposition
 */
function createSystemRouter({ config, healthService, metrics, state }) {
  const router = express.Router();

  router.get('/livez', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'alive' });
  });

  router.get('/health', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const h = await healthService.check();
    const draining = state.draining;
    const status = draining ? 'DRAINING' : h.status;
    res.status(status === 'DOWN' || draining ? 503 : 200).json({
      status,
      mongo: h.mongo.state,
      redis: h.redis.state,
      checks: {
        mongo: { up: h.mongo.up, latencyMs: h.mongo.latencyMs, ...(h.mongo.error ? { error: h.mongo.error } : {}) },
        redis: { up: h.redis.up, latencyMs: h.redis.latencyMs, ...(h.redis.error ? { error: h.redis.error } : {}) },
      },
      version: h.version,
      commit: h.commit,
      uptimeSeconds: h.uptimeSeconds,
      timestamp: h.timestamp,
    });
  });

  router.get('/metrics', async (req, res) => {
    if (!config.metrics.enabled) return res.status(404).end();
    if (config.metrics.token) {
      const presented = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!safeEqual(presented, config.metrics.token)) {
        return res.status(401).set('WWW-Authenticate', 'Bearer').end();
      }
    }
    res.set('Content-Type', metrics.register.contentType);
    return res.end(await metrics.register.metrics());
  });

  return router;
}

module.exports = { createSystemRouter };
