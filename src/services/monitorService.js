'use strict';

const { probeUrl } = require('./probe');

/**
 * Background scheduler for destination uptime probes.
 *
 * Every `tickSeconds` it claims up to `batchSize` links that are due (atomic
 * lease, safe with several replicas), probes them with bounded concurrency and
 * stores the result + a rolling history that powers the sparkline in the UI.
 */
class MonitorService {
  constructor({ config, urlRepo, logger, metrics, probe = probeUrl }) {
    this.cfg = config.monitor;
    this.allowPrivate = config.allowPrivateTargets;
    this.urlRepo = urlRepo;
    this.logger = logger;
    this.metrics = metrics;
    this.probe = probe;
    this.timer = null;
    this.running = null;
  }

  start() {
    if (!this.cfg.enabled || this.timer) return;
    this.timer = setInterval(() => this.runOnce().catch(() => {}), this.cfg.tickSeconds * 1000);
    this.timer.unref();
    this.logger.info(
      { tickSeconds: this.cfg.tickSeconds, batchSize: this.cfg.batchSize },
      'uptime monitor scheduler started',
    );
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }

  /** Run one scheduling cycle. Overlapping cycles are collapsed into one. */
  runOnce(now = new Date()) {
    if (this.running) return this.running;
    this.running = this.#cycle(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async #cycle(now) {
    const leaseMs = this.cfg.timeoutMs * 2 + 30_000;
    const due = await this.urlRepo.claimDueMonitors(this.cfg.batchSize, now, leaseMs);
    if (!due.length) return [];

    const results = [];
    const queue = [...due];
    const worker = async () => {
      while (queue.length) {
        const link = queue.shift();
        results.push(await this.#probeOne(link));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.cfg.concurrency, due.length) }, worker));
    return results;
  }

  async #probeOne(link) {
    const result = await this.probe(link.originalUrl, {
      timeoutMs: this.cfg.timeoutMs,
      allowPrivate: this.allowPrivate,
    });
    this.metrics.recordProbe(result.ok, (result.latencyMs ?? 0) / 1000);
    try {
      await this.urlRepo.recordProbe(link.shortCode, result, {
        now: new Date(),
        intervalSec: link.monitor.intervalSec ?? this.cfg.defaultIntervalSeconds,
      });
    } catch (err) {
      this.logger.error({ err: err.message, shortCode: link.shortCode }, 'failed to store probe result');
    }
    if (!result.ok) {
      this.logger.warn({ shortCode: link.shortCode, error: result.error }, 'monitored link probe failed');
    }
    return { shortCode: link.shortCode, ...result };
  }
}

module.exports = { MonitorService };
