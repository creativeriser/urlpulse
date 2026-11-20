'use strict';

const { rateLimit } = require('express-rate-limit');

const limitHandler = (req, res) => {
  res.status(429).json({
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests from this address. Please slow down and try again shortly.',
    },
  });
};

function build(max, config, { windowMs = config.rateLimit.windowMs, skip } = {}) {
  if (!config.rateLimit.enabled) return (req, res, next) => next();
  return rateLimit({
    windowMs,
    skip,
    limit: max,
    standardHeaders: 'draft-7', // RateLimit-* headers
    legacyHeaders: false,
    handler: limitHandler,
  });
}

/**
 * Three buckets, so the dashboard (many cheap reads) never starves link creation:
 *  - write : POST /shorten, PATCH, DELETE      (default 100 / 15 min / IP)
 *  - read  : analytics, link info, QR, stats   (default 600 / 15 min / IP)
 *  - public: redirects, HTML pages, 404 page   (default 600 / 1 min / IP)
 *
 * `public` is mounted after the /api router and the system routes, so it never
 * overlaps the other two and never throttles /livez, /health or /metrics. Files
 * under /assets are skipped: they are static, cacheable and a page needs many.
 * Behind nginx (Compose) this is a second line of defence; on Render, which has
 * no nginx, it is the only per-IP limit on the redirect path.
 *
 * Counters live in process memory. With several replicas, swap in
 * `rate-limit-redis` as the store (see DOCUMENTATION.md > Scaling).
 */
function createRateLimiters(config) {
  return {
    write: build(config.rateLimit.writeMax, config),
    read: build(config.rateLimit.readMax, config),
    public: build(config.rateLimit.publicMax, config, {
      windowMs: config.rateLimit.publicWindowMs,
      skip: (req) => req.path.startsWith('/assets/'),
    }),
  };
}

module.exports = { createRateLimiters };
