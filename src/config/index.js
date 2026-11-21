'use strict';

const pkg = require('../../package.json');

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback, { min = -Infinity, max = Infinity } = {}) => {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer value: "${value}"`);
  return Math.min(max, Math.max(min, n));
};

/**
 * Build the runtime configuration from an environment-like object.
 * Pure function (no side effects) so tests can pass their own env.
 */
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const mongoUri = env.MONGO_URI || '';
  // No MONGO_URI => zero-dependency "memory" mode (dev / demos / tests).
  const storage = env.STORAGE || (mongoUri ? 'mongo' : 'memory');
  if (!['mongo', 'memory'].includes(storage)) {
    throw new Error(`STORAGE must be "mongo" or "memory", got "${storage}"`);
  }
  if (storage === 'mongo' && !mongoUri) {
    throw new Error('MONGO_URI is required when STORAGE=mongo');
  }

  const redisUrl =
    env.REDIS_URL ||
    (env.REDIS_HOST ? `redis://${env.REDIS_HOST}:${env.REDIS_PORT || 6379}` : '');
  const cache = env.CACHE || (redisUrl ? 'redis' : 'memory');
  if (!['redis', 'memory', 'none'].includes(cache)) {
    throw new Error(`CACHE must be "redis", "memory" or "none", got "${cache}"`);
  }
  if (cache === 'redis' && !redisUrl) {
    throw new Error('REDIS_URL (or REDIS_HOST) is required when CACHE=redis');
  }

  const hashSalt = env.HASH_SALT || 'urlpulse-dev-salt-not-for-production';
  if (isProduction && (!env.HASH_SALT || env.HASH_SALT.length < 16)) {
    throw new Error('HASH_SALT must be set (>= 16 chars) when NODE_ENV=production');
  }

  // CORS is off unless CORS_ORIGIN lists explicit origins. A wildcard is refused
  // outright: the API is public and header-token based, so an allowlist is the
  // only configuration that makes sense.
  const corsOrigins = (env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (corsOrigins.includes('*')) {
    throw new Error('CORS_ORIGIN must be a comma-separated list of explicit origins; "*" is not allowed');
  }

  // The Dockerfile bakes BUILD_SHA=dev into the image when CI does not pass one
  // (for example Render building from the repo), so "dev" counts as "unset".
  const buildSha = env.BUILD_SHA && env.BUILD_SHA !== 'dev' ? env.BUILD_SHA : '';

  const trustProxyRaw = env.TRUST_PROXY ?? '0';
  const trustProxy = /^\d+$/.test(trustProxyRaw) ? Number(trustProxyRaw) : trustProxyRaw;

  const config = {
    name: pkg.name,
    version: pkg.version,
    commit: buildSha || env.RENDER_GIT_COMMIT || 'dev',
    buildDate: env.BUILD_DATE || null,
    nodeEnv,
    isProduction,
    isTest,

    port: int(env.PORT, 5000, { min: 0, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''),
    trustProxy,
    corsOrigin: corsOrigins.join(','),

    storage,
    mongoUri,
    cache,
    redisUrl,
    cacheTtlSeconds: int(env.CACHE_TTL_SECONDS, 86400, { min: 1 }),
    negativeCacheTtlSeconds: int(env.NEGATIVE_CACHE_TTL_SECONDS, 60, { min: 0 }),

    hashSalt,
    maxUrlLength: int(env.MAX_URL_LENGTH, 2048, { min: 16, max: 8192 }),
    allowPrivateTargets: bool(env.ALLOW_PRIVATE_TARGETS, false),
    codeLength: int(env.CODE_LENGTH, 7, { min: 4, max: 16 }),

    rateLimit: {
      windowMs: int(env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, { min: 1000 }),
      writeMax: int(env.RATE_LIMIT_MAX, 100, { min: 1 }),
      readMax: int(env.READ_RATE_LIMIT_MAX, 600, { min: 1 }),
      // Redirects, HTML pages and the 404 page (everything outside /api and /assets).
      publicMax: int(env.PUBLIC_RATE_LIMIT_MAX, 600, { min: 1 }),
      publicWindowMs: int(env.PUBLIC_RATE_LIMIT_WINDOW_MS, 60 * 1000, { min: 1000 }),
      enabled: bool(env.RATE_LIMIT_ENABLED, !isTest),
    },

    clicks: {
      flushIntervalMs: int(env.CLICK_FLUSH_MS, 2000, { min: 50 }),
      maxBatch: int(env.CLICK_BATCH_SIZE, 500, { min: 1 }),
      maxQueue: int(env.CLICK_QUEUE_LIMIT, 20000, { min: 100 }),
      retentionDays: int(env.CLICK_RETENTION_DAYS, 90, { min: 1 }),
    },

    monitor: {
      enabled: bool(env.MONITOR_ENABLED, !isTest),
      tickSeconds: int(env.MONITOR_TICK_SECONDS, 30, { min: 1 }),
      batchSize: int(env.MONITOR_BATCH_SIZE, 20, { min: 1 }),
      concurrency: int(env.MONITOR_CONCURRENCY, 5, { min: 1, max: 50 }),
      defaultIntervalSeconds: int(env.MONITOR_INTERVAL_SECONDS, 300, { min: 10 }),
      timeoutMs: int(env.MONITOR_TIMEOUT_MS, 8000, { min: 500 }),
    },

    metrics: {
      enabled: bool(env.METRICS_ENABLED, true),
      token: env.METRICS_TOKEN || '',
    },

    logLevel: env.LOG_LEVEL || (isTest ? 'silent' : isProduction ? 'info' : 'debug'),
    logPretty: bool(env.LOG_PRETTY, !isProduction && !isTest),
    shutdownTimeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, 10000, { min: 1000 }),
  };

  return Object.freeze(config);
}

module.exports = { loadConfig };
