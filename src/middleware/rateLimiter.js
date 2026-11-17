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

function build(max, config) {
  if (!config.rateLimit.enabled) return (req, res, next) => next();
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: max,
    standardHeaders: 'draft-7', // RateLimit-* headers
    legacyHeaders: false,
    handler: limitHandler,
  });
}

/**
 * Two buckets so the dashboard (many cheap reads) never starves link creation:
 *  - write: POST /shorten, PATCH, DELETE      (default 100 / 15 min / IP)
 *  - read : analytics, link info, QR, stats   (default 600 / 15 min / IP)
 *
 * Counters live in process memory. With several replicas, swap in
 * `rate-limit-redis` as the store (see DOCUMENTATION.md > Scaling).
 */
function createRateLimiters(config) {
  return { write: build(config.rateLimit.writeMax, config), read: build(config.rateLimit.readMax, config) };
}

module.exports = { createRateLimiters };
