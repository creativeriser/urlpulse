'use strict';

const { DuplicateKeyError } = require('../../lib/errors');

const HISTORY_LIMIT = 48;

const emptyMonitor = () => ({
  enabled: false,
  intervalSec: null,
  nextCheckAt: null,
  lastCheckedAt: null,
  lastStatus: null,
  lastLatencyMs: null,
  lastOk: null,
  lastError: null,
  consecutiveFailures: 0,
  checks: 0,
  successes: 0,
  history: [],
});

const clone = (record) => (record ? structuredClone(record) : null);

/**
 * In-memory implementation of the URL repository contract.
 * Used for local development without infrastructure and for fast unit tests.
 * Mirrors the semantics of the MongoDB adapter (same method names/results).
 */
class MemoryUrlRepository {
  constructor() {
    this.records = new Map();
  }

  async create({ shortCode, originalUrl, customAlias = false, expiresAt = null, manageTokenHash, monitor }) {
    if (this.records.has(shortCode)) throw new DuplicateKeyError(shortCode);
    const now = new Date();
    const record = {
      shortCode,
      originalUrl,
      customAlias,
      clickCount: 0,
      expiresAt,
      manageTokenHash,
      createdAt: now,
      updatedAt: now,
      monitor: emptyMonitor(),
    };
    if (monitor?.enabled) {
      record.monitor.enabled = true;
      record.monitor.intervalSec = monitor.intervalSec;
      record.monitor.nextCheckAt = now;
    }
    this.records.set(shortCode, record);
    return clone(record);
  }

  async findByCode(shortCode) {
    return clone(this.records.get(shortCode));
  }

  async deleteByCode(shortCode) {
    return this.records.delete(shortCode);
  }

  async incrementClicks(shortCode, amount = 1) {
    const record = this.records.get(shortCode);
    if (record) {
      record.clickCount += amount;
      record.updatedAt = new Date();
    }
  }

  async setMonitor(shortCode, { enabled, intervalSec }) {
    const record = this.records.get(shortCode);
    if (!record) return null;
    record.monitor.enabled = Boolean(enabled);
    if (enabled) {
      record.monitor.intervalSec = intervalSec;
      record.monitor.nextCheckAt = new Date();
    } else {
      record.monitor.nextCheckAt = null;
    }
    record.updatedAt = new Date();
    return clone(record);
  }

  /**
   * Atomically "lease" up to `limit` links whose probe is due. Pushing
   * nextCheckAt forward by leaseMs stops other workers re-claiming them.
   */
  async claimDueMonitors(limit, now = new Date(), leaseMs = 60_000) {
    const due = [...this.records.values()]
      .filter((r) => r.monitor.enabled && r.monitor.nextCheckAt && r.monitor.nextCheckAt <= now)
      .sort((a, b) => a.monitor.nextCheckAt - b.monitor.nextCheckAt)
      .slice(0, limit);
    due.forEach((r) => {
      r.monitor.nextCheckAt = new Date(now.getTime() + leaseMs);
    });
    return due.map(clone);
  }

  async recordProbe(shortCode, result, { now = new Date(), intervalSec } = {}) {
    const record = this.records.get(shortCode);
    if (!record || !record.monitor.enabled) return;
    const m = record.monitor;
    m.lastCheckedAt = now;
    m.lastStatus = result.status ?? null;
    m.lastLatencyMs = result.latencyMs ?? null;
    m.lastOk = result.ok;
    m.lastError = result.error ?? null;
    m.consecutiveFailures = result.ok ? 0 : m.consecutiveFailures + 1;
    m.checks += 1;
    m.successes += result.ok ? 1 : 0;
    m.nextCheckAt = new Date(now.getTime() + (intervalSec ?? m.intervalSec ?? 300) * 1000);
    m.history.push({ t: now, ok: result.ok, ms: result.latencyMs ?? null });
    if (m.history.length > HISTORY_LIMIT) m.history.splice(0, m.history.length - HISTORY_LIMIT);
  }

  async counts() {
    let clicks = 0;
    let monitored = 0;
    let monitoredDown = 0;
    for (const r of this.records.values()) {
      clicks += r.clickCount;
      if (r.monitor.enabled) {
        monitored += 1;
        if (r.monitor.consecutiveFailures >= 2) monitoredDown += 1;
      }
    }
    return { links: this.records.size, clicks, monitored, monitoredDown };
  }

  async ping() {
    return 0;
  }

  async close() {}
}

module.exports = { MemoryUrlRepository, HISTORY_LIMIT };
