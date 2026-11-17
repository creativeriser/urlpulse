'use strict';

const MAX_ENTRIES = 100_000; // hard cap so memory mode can never exhaust the heap

const tally = (entries, pick) => {
  const counts = new Map();
  for (const entry of entries) {
    const key = pick(entry);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
};

/** In-memory implementation of the click-log repository contract. */
class MemoryClickRepository {
  constructor() {
    this.logs = [];
  }

  async insertMany(entries) {
    this.logs.push(...entries.map((e) => ({ ...e })));
    if (this.logs.length > MAX_ENTRIES) this.logs.splice(0, this.logs.length - MAX_ENTRIES);
  }

  async aggregate(shortCode, { since, recentLimit = 10, referrerLimit = 10 }) {
    const entries = this.logs.filter((l) => l.shortCode === shortCode && l.timestamp >= since);
    const timeline = tally(entries, (l) => l.timestamp.toISOString().slice(0, 10))
      .map(({ key, count }) => ({ date: key, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      total: entries.length,
      browsers: tally(entries, (l) => l.browser),
      os: tally(entries, (l) => l.os),
      devices: tally(entries, (l) => l.device),
      referrers: tally(entries, (l) => l.referrer || '').slice(0, referrerLimit),
      timeline,
      recent: [...entries]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, recentLimit)
        .map(({ timestamp, browser, os, device, referrer }) => ({ timestamp, browser, os, device, referrer })),
    };
  }

  async deleteByCode(shortCode) {
    this.logs = this.logs.filter((l) => l.shortCode !== shortCode);
  }

  async close() {}
}

module.exports = { MemoryClickRepository };
