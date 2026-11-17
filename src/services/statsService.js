'use strict';

/**
 * Aggregate, cached counters used by GET /api/stats and the Prometheus gauges.
 * A short TTL means a 15-second scrape interval plus a busy landing page do
 * not translate into repeated collection scans.
 */
class StatsService {
  constructor({ urlRepo, clickBuffer, metrics, config, ttlMs = 10_000, now = () => Date.now() }) {
    this.urlRepo = urlRepo;
    this.clickBuffer = clickBuffer;
    this.metrics = metrics;
    this.config = config;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cached = null;
    this.cachedAt = 0;
    this.startedAt = new Date(this.now());
  }

  /** Database-backed counters (cached for ttlMs). */
  async snapshot() {
    if (this.cached && this.now() - this.cachedAt < this.ttlMs) return this.cached;
    this.cached = await this.urlRepo.counts();
    this.cachedAt = this.now();
    return this.cached;
  }

  async publicStats() {
    const db = await this.snapshot();
    const { cacheHits, cacheMisses } = this.metrics.runtime;
    const lookups = cacheHits + cacheMisses;
    return {
      links: db.links,
      clicks: db.clicks,
      monitoredLinks: db.monitored,
      monitoredLinksDown: db.monitoredDown,
      cache: {
        hits: cacheHits,
        misses: cacheMisses,
        hitRatio: lookups ? Math.round((cacheHits / lookups) * 10_000) / 10_000 : null,
      },
      features: { monitoring: this.config.monitor.enabled },
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: this.startedAt.toISOString(),
      version: this.config.version,
      commit: this.config.commit,
    };
  }
}

module.exports = { StatsService };
