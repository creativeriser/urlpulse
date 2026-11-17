'use strict';

/**
 * Write-behind buffer for click events.
 *
 * Why: persisting every click synchronously would put one (or two) database
 * writes on the redirect hot path. Instead the redirect handler pushes the
 * event into memory (O(1)) and this buffer flushes in batches:
 *   - one insertMany() for the click logs
 *   - one $inc per distinct short code for the denormalised counter
 *
 * Trade-offs (documented in DOCUMENTATION.md): clicks are eventually
 * consistent (<= flush interval) and up to one batch can be lost if the
 * process is hard-killed. A graceful shutdown flushes everything first.
 */
class ClickBuffer {
  constructor({ clickRepo, urlRepo, config, logger, metrics }) {
    this.clickRepo = clickRepo;
    this.urlRepo = urlRepo;
    this.cfg = config.clicks;
    this.logger = logger;
    this.metrics = metrics;
    this.queue = [];
    this.pending = new Map(); // shortCode -> clicks not yet persisted
    this.timer = null;
    this.flushing = null;
  }

  record(entry) {
    if (this.queue.length >= this.cfg.maxQueue) {
      const dropped = this.queue.shift();
      this.#decrementPending(dropped.shortCode, 1);
      this.metrics.recordClicksDropped(1);
    }
    this.queue.push(entry);
    this.pending.set(entry.shortCode, (this.pending.get(entry.shortCode) || 0) + 1);
    this.metrics.setClickQueueSize(this.queue.length);
    if (this.queue.length >= this.cfg.maxBatch) this.flush().catch(() => {});
  }

  /** Clicks recorded but not yet persisted (lets the API show instant counts). */
  pendingClicks(shortCode) {
    return this.pending.get(shortCode) || 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush().catch(() => {}), this.cfg.flushIntervalMs);
    this.timer.unref();
  }

  /** Flush until the queue is empty. Concurrent callers share one in-flight flush. */
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.#drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  async #drain() {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.cfg.maxBatch);
      const perCode = new Map();
      batch.forEach((e) => perCode.set(e.shortCode, (perCode.get(e.shortCode) || 0) + 1));

      try {
        await this.clickRepo.insertMany(batch);
        await Promise.all([...perCode].map(([code, n]) => this.urlRepo.incrementClicks(code, n)));
        perCode.forEach((n, code) => this.#decrementPending(code, n));
        this.metrics.recordClicksPersisted(batch.length);
      } catch (err) {
        // Put the batch back (front of the queue) and retry on the next tick.
        this.queue.unshift(...batch);
        this.metrics.recordClickFlushFailure();
        this.logger.error({ err: err.message, queued: this.queue.length }, 'click flush failed; will retry');
        break;
      } finally {
        this.metrics.setClickQueueSize(this.queue.length);
      }
    }
  }

  #decrementPending(code, n) {
    const left = (this.pending.get(code) || 0) - n;
    if (left > 0) this.pending.set(code, left);
    else this.pending.delete(code);
  }
}

module.exports = { ClickBuffer };
