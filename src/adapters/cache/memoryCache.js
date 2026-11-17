'use strict';

/**
 * Minimal TTL cache with the same contract as the Redis adapter
 * (get / set / del / ping / close). Bounded so it cannot grow without limit.
 */
class MemoryCache {
  constructor({ maxEntries = 10_000, now = () => Date.now() } = {}) {
    this.store = new Map();
    this.maxEntries = maxEntries;
    this.now = now;
    this.kind = 'memory';
  }

  async get(key) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key, value, ttlSeconds) {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      // Map preserves insertion order: evict the oldest entry.
      this.store.delete(this.store.keys().next().value);
    }
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(key) {
    this.store.delete(key);
  }

  async ping() {
    return 0;
  }

  isReady() {
    return true;
  }

  async close() {
    this.store.clear();
  }
}

/** Cache that stores nothing (CACHE=none): every lookup is a miss. */
class NullCache {
  constructor() {
    this.kind = 'none';
  }
  async get() {
    return null;
  }
  async set() {}
  async del() {}
  async ping() {
    return 0;
  }
  isReady() {
    return true;
  }
  async close() {}
}

module.exports = { MemoryCache, NullCache };
