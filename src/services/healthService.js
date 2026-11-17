'use strict';

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);

/**
 * Dependency health model:
 *   UP        everything reachable
 *   DEGRADED  Redis is down but MongoDB is fine -> redirects still work (just slower)
 *   DOWN      MongoDB is unreachable -> the service cannot do its job (HTTP 503)
 *
 * Results are cached briefly so Docker, Prometheus and the status page polling
 * at the same time do not each trigger their own round of pings.
 */
class HealthService {
  constructor({ config, urlRepo, cache, ttlMs = 2000, now = () => Date.now() }) {
    this.config = config;
    this.urlRepo = urlRepo;
    this.cache = cache;
    this.ttlMs = ttlMs;
    this.now = now;
    this.last = null;
    this.lastAt = 0;
    this.inflight = null;
  }

  async check() {
    if (this.last && this.now() - this.lastAt < this.ttlMs) return this.last;
    if (!this.inflight) {
      this.inflight = this.#run().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async #run() {
    const [mongo, redis] = await Promise.all([
      this.#probe(() => this.urlRepo.ping(), this.config.storage === 'mongo' ? 'connected' : 'memory'),
      this.config.cache === 'redis'
        ? this.#probe(() => this.cache.ping(), 'connected')
        : Promise.resolve({
            up: true,
            state: this.config.cache === 'memory' ? 'memory' : 'disabled',
            latencyMs: null,
          }),
    ]);

    let status = 'UP';
    if (!redis.up) status = 'DEGRADED';
    if (!mongo.up) status = 'DOWN';

    this.last = {
      status,
      mongo,
      redis,
      version: this.config.version,
      commit: this.config.commit,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date(this.now()).toISOString(),
    };
    this.lastAt = this.now();
    return this.last;
  }

  async #probe(fn, okState) {
    try {
      const ms = await withTimeout(fn(), 1500);
      return { up: true, state: okState, latencyMs: Math.round(ms * 100) / 100 };
    } catch (err) {
      return { up: false, state: 'disconnected', latencyMs: null, error: err.message };
    }
  }
}

module.exports = { HealthService };
