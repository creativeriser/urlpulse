'use strict';

const Redis = require('ioredis');

/**
 * Redis-backed cache.
 *
 * Design goals:
 *  - NEVER take the redirect path down: every operation swallows errors and
 *    behaves like a cache miss, so a Redis outage degrades latency, not availability.
 *  - Fail fast: no offline queue and a short command timeout, so a dead Redis
 *    does not add seconds to each request.
 */
class RedisCache {
  constructor(url, { logger, client } = {}) {
    this.kind = 'redis';
    this.logger = logger;
    this.client =
      client ||
      new Redis(url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 3000,
        commandTimeout: 500,
        retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
      });

    this.client.on('error', (err) => this.logger?.warn({ err: err.message }, 'redis error'));
    this.client.on('ready', () => this.logger?.info('redis connection ready'));
    this.client.on('end', () => this.logger?.warn('redis connection closed'));
  }

  /** Start connecting but never block start-up on Redis being available. */
  async connect() {
    try {
      await this.client.connect();
    } catch (err) {
      this.logger?.warn({ err: err.message }, 'redis unavailable at start-up; continuing without cache');
    }
  }

  isReady() {
    return this.client.status === 'ready';
  }

  async get(key) {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    try {
      await this.client.set(key, value, 'EX', Math.max(1, Math.floor(ttlSeconds)));
    } catch {
      /* cache write failures are non-fatal */
    }
  }

  async del(key) {
    try {
      await this.client.del(key);
    } catch {
      /* ignore */
    }
  }

  /** Round-trip latency in ms; throws if Redis is unreachable. */
  async ping() {
    const start = process.hrtime.bigint();
    const reply = await this.client.ping();
    if (reply !== 'PONG') throw new Error('unexpected PING reply');
    return Number(process.hrtime.bigint() - start) / 1e6;
  }

  async close() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

module.exports = { RedisCache };
