'use strict';

const { AppError, DuplicateKeyError } = require('../lib/errors');
const { generateCode } = require('../lib/base62');
const { generateManageToken, sha256, tokenMatches } = require('../lib/crypto');
const {
  validateAlias,
  validateTargetUrl,
  resolveExpiry,
  isReserved,
  isShortCodeShape,
} = require('../lib/validators');
const { toPublicLink } = require('./linkView');

const NEGATIVE_MARKER = '0';
const MAX_CODE_ATTEMPTS = 6;
const cacheKey = (code) => `url:${code}`;

class LinkService {
  constructor({ config, urlRepo, clickRepo, cache, clickBuffer, metrics, logger }) {
    this.config = config;
    this.urlRepo = urlRepo;
    this.clickRepo = clickRepo;
    this.cache = cache;
    this.clickBuffer = clickBuffer;
    this.metrics = metrics;
    this.logger = logger;
  }

  /** Create a short link (random Base62 code or a validated custom alias). */
  async create(input, { baseUrl, selfHosts = [] }) {
    const originalUrl = validateTargetUrl(input.originalUrl, {
      maxLength: this.config.maxUrlLength,
      allowPrivateTargets: this.config.allowPrivateTargets,
      selfHosts,
    });
    const expiresAt = resolveExpiry(input);
    const monitor = this.#resolveMonitor(input);

    const token = generateManageToken();
    const base = { originalUrl, expiresAt, manageTokenHash: sha256(token), monitor };

    let record;
    if (input.customAlias !== undefined && input.customAlias !== null && input.customAlias !== '') {
      const alias = validateAlias(input.customAlias);
      try {
        record = await this.urlRepo.create({ ...base, shortCode: alias, customAlias: true });
      } catch (err) {
        if (err instanceof DuplicateKeyError) {
          throw AppError.conflict(`The alias "${alias}" is already taken. Try another one.`);
        }
        throw err;
      }
    } else {
      record = await this.#createWithGeneratedCode(base);
    }

    // A previous 404 for this code may be cached (negative cache): clear it.
    await this.cache.del(cacheKey(record.shortCode));
    this.metrics.recordLinkCreated(record.customAlias ? 'custom' : 'random');
    this.logger.info({ shortCode: record.shortCode, custom: record.customAlias }, 'link created');

    return {
      link: toPublicLink(record, { baseUrl }),
      manageToken: token,
    };
  }

  async #createWithGeneratedCode(base) {
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
      const shortCode = generateCode(this.config.codeLength);
      if (isReserved(shortCode)) continue;
      try {
        return await this.urlRepo.create({ ...base, shortCode, customAlias: false });
      } catch (err) {
        if (!(err instanceof DuplicateKeyError)) throw err;
        this.logger.warn({ shortCode, attempt }, 'short code collision; retrying');
      }
    }
    throw new AppError(503, 'CODE_GENERATION_FAILED', 'Could not allocate a unique short code, please retry');
  }

  #resolveMonitor(input) {
    if (!input.monitor) return null;
    if (!this.config.monitor.enabled) {
      throw AppError.validation('Uptime monitoring is disabled on this server', { field: 'monitor' });
    }
    return { enabled: true, intervalSec: this.#resolveInterval(input.monitorIntervalSeconds) };
  }

  #resolveInterval(value) {
    if (value === undefined || value === null || value === '') {
      return this.config.monitor.defaultIntervalSeconds;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 30 || n > 86_400) {
      throw AppError.validation('monitorIntervalSeconds must be a whole number between 30 and 86400', {
        field: 'monitorIntervalSeconds',
      });
    }
    return n;
  }

  /**
   * Hot path: resolve a short code to its destination.
   * cache hit -> return; miss -> database -> populate cache.
   */
  async resolve(shortCode, now = new Date()) {
    const key = cacheKey(shortCode);

    const cached = await this.cache.get(key);
    if (cached !== null) {
      const parsed = this.#parseCache(cached);
      if (parsed) {
        this.metrics.recordCacheHit();
        if (parsed.negative) throw AppError.notFound();
        if (parsed.expiresAt && parsed.expiresAt <= now) throw AppError.gone();
        return { originalUrl: parsed.originalUrl, source: 'cache' };
      }
    }

    this.metrics.recordCacheMiss();
    const record = await this.urlRepo.findByCode(shortCode);
    if (!record) {
      // Negative caching shields the database from scanners hammering unknown codes.
      if (this.config.negativeCacheTtlSeconds > 0) {
        await this.cache.set(key, NEGATIVE_MARKER, this.config.negativeCacheTtlSeconds);
      }
      throw AppError.notFound();
    }
    if (record.expiresAt && record.expiresAt <= now) throw AppError.gone();

    let ttl = this.config.cacheTtlSeconds;
    if (record.expiresAt) ttl = Math.min(ttl, Math.floor((record.expiresAt - now) / 1000));
    if (ttl > 0) {
      await this.cache.set(
        key,
        JSON.stringify({ u: record.originalUrl, e: record.expiresAt ? record.expiresAt.toISOString() : null }),
        ttl,
      );
    }
    return { originalUrl: record.originalUrl, source: 'database' };
  }

  #parseCache(raw) {
    if (raw === NEGATIVE_MARKER) return { negative: true };
    try {
      const { u, e } = JSON.parse(raw);
      if (typeof u !== 'string') return null;
      return { originalUrl: u, expiresAt: e ? new Date(e) : null };
    } catch {
      return null; // corrupt entry => treat as a miss
    }
  }

  async get(shortCode, { baseUrl }) {
    const record = await this.#requireRecord(shortCode);
    return toPublicLink(record, { baseUrl, pendingClicks: this.clickBuffer.pendingClicks(shortCode) });
  }

  async remove(shortCode, token) {
    const record = await this.#requireRecord(shortCode);
    this.#authorise(record, token);
    await this.urlRepo.deleteByCode(shortCode);
    await this.clickRepo.deleteByCode(shortCode);
    await this.cache.del(cacheKey(shortCode));
    this.metrics.recordLinkDeleted();
    this.logger.info({ shortCode }, 'link deleted');
  }

  /** Enable / disable uptime monitoring for an existing link. */
  async setMonitor(shortCode, token, { enabled, intervalSeconds }, { baseUrl }) {
    if (typeof enabled !== 'boolean') {
      throw AppError.validation('"enabled" must be true or false', { field: 'enabled' });
    }
    if (enabled && !this.config.monitor.enabled) {
      throw AppError.validation('Uptime monitoring is disabled on this server', { field: 'enabled' });
    }
    const record = await this.#requireRecord(shortCode);
    this.#authorise(record, token);
    const updated = await this.urlRepo.setMonitor(shortCode, {
      enabled,
      intervalSec: this.#resolveInterval(intervalSeconds),
    });
    return toPublicLink(updated, { baseUrl, pendingClicks: this.clickBuffer.pendingClicks(shortCode) });
  }

  /** Is this alias free and allowed? Powers the live check in the UI. */
  async checkAlias(alias) {
    try {
      validateAlias(alias);
    } catch (err) {
      return { alias, available: false, reason: err.message };
    }
    const taken = await this.urlRepo.findByCode(alias);
    return taken
      ? { alias, available: false, reason: 'That alias is already taken' }
      : { alias, available: true };
  }

  async #requireRecord(shortCode) {
    if (!isShortCodeShape(shortCode)) throw AppError.notFound();
    const record = await this.urlRepo.findByCode(shortCode);
    if (!record) throw AppError.notFound();
    return record;
  }

  #authorise(record, token) {
    if (!token) throw AppError.unauthorized();
    if (!tokenMatches(token, record.manageTokenHash)) throw AppError.forbidden();
  }
}

module.exports = { LinkService };
