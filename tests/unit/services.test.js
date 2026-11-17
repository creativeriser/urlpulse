'use strict';

const { buildTestApp } = require('../helpers/testApp');
const { MemoryCache, NullCache } = require('../../src/adapters/cache/memoryCache');
const { MemoryUrlRepository } = require('../../src/adapters/memory/urlRepository');
const { MemoryClickRepository } = require('../../src/adapters/memory/clickRepository');
const { DuplicateKeyError } = require('../../src/lib/errors');
const { ClickBuffer } = require('../../src/services/clickBuffer');
const { probeUrl } = require('../../src/services/probe');
const { createMetrics } = require('../../src/metrics');
const { loadConfig } = require('../../src/config');

const ctx = { baseUrl: 'http://short.test', selfHosts: ['short.test'] };

describe('MemoryCache', () => {
  test('expires entries by TTL and evicts the oldest when full', async () => {
    let t = 1_000;
    const cache = new MemoryCache({ maxEntries: 2, now: () => t });
    await cache.set('a', '1', 10);
    await cache.set('b', '2', 10);
    await cache.set('c', '3', 10); // evicts "a"
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toBe('2');
    t += 11_000;
    expect(await cache.get('b')).toBeNull();
    expect(await new NullCache().get('x')).toBeNull();
  });
});

describe('LinkService', () => {
  test('creates links with random 7-char codes or custom aliases, and rejects duplicates', async () => {
    const { container } = await buildTestApp();
    const { link, manageToken } = await container.linkService.create({ originalUrl: 'https://example.com' }, ctx);
    expect(link.shortCode).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(link.shortUrl).toBe(`http://short.test/${link.shortCode}`);
    expect(manageToken).toBeTruthy();
    expect(link).not.toHaveProperty('manageTokenHash');

    await container.linkService.create({ originalUrl: 'https://example.com', customAlias: 'my-portfolio' }, ctx);
    await expect(
      container.linkService.create({ originalUrl: 'https://example.org', customAlias: 'my-portfolio' }, ctx),
    ).rejects.toMatchObject({ status: 409, code: 'ALIAS_TAKEN' });
  });

  test('retries on a random-code collision and eventually succeeds', async () => {
    class FlakyRepo extends MemoryUrlRepository {
      calls = 0;
      async create(input) {
        this.calls += 1;
        if (this.calls <= 2) throw new DuplicateKeyError(input.shortCode);
        return super.create(input);
      }
    }
    const repo = new FlakyRepo();
    const { container } = await buildTestApp({}, { urlRepo: repo, clickRepo: new MemoryClickRepository() });
    const { link } = await container.linkService.create({ originalUrl: 'https://example.com' }, ctx);
    expect(link.shortCode).toBeTruthy();
    expect(repo.calls).toBe(3);
  });

  test('gives up with 503 after repeated collisions', async () => {
    class AlwaysDuplicate extends MemoryUrlRepository {
      async create(input) {
        throw new DuplicateKeyError(input.shortCode);
      }
    }
    const { container } = await buildTestApp({}, { urlRepo: new AlwaysDuplicate(), clickRepo: new MemoryClickRepository() });
    await expect(container.linkService.create({ originalUrl: 'https://example.com' }, ctx)).rejects.toMatchObject({
      status: 503,
    });
  });

  test('resolve: database on first lookup, cache afterwards', async () => {
    const { container } = await buildTestApp();
    const { link } = await container.linkService.create({ originalUrl: 'https://example.com/x' }, ctx);
    expect(await container.linkService.resolve(link.shortCode)).toEqual({
      originalUrl: 'https://example.com/x',
      source: 'database',
    });
    expect((await container.linkService.resolve(link.shortCode)).source).toBe('cache');
    expect(container.metrics.runtime).toMatchObject({ cacheMisses: 1, cacheHits: 1 });
  });

  test('negative-caches unknown codes so scanners do not hammer the database', async () => {
    const { container } = await buildTestApp();
    const spy = jest.spyOn(container.urlRepo, 'findByCode');
    await expect(container.linkService.resolve('nope123')).rejects.toMatchObject({ status: 404 });
    await expect(container.linkService.resolve('nope123')).rejects.toMatchObject({ status: 404 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('creating a link clears a stale negative-cache entry for that code', async () => {
    const { container } = await buildTestApp();
    await expect(container.linkService.resolve('freshalias')).rejects.toMatchObject({ status: 404 });
    await container.linkService.create({ originalUrl: 'https://example.com', customAlias: 'freshalias' }, ctx);
    expect((await container.linkService.resolve('freshalias')).originalUrl).toBe('https://example.com/');
  });

  test('expired links return 410 and are never served from cache after expiry', async () => {
    const { container } = await buildTestApp();
    const { link } = await container.linkService.create({ originalUrl: 'https://example.com', expiresInDays: 1 }, ctx);
    await container.linkService.resolve(link.shortCode); // warms cache
    const later = new Date(Date.now() + 2 * 86_400_000);
    await expect(container.linkService.resolve(link.shortCode, later)).rejects.toMatchObject({ status: 410 });
  });

  test('a corrupt cache entry is treated as a miss, not an error', async () => {
    const cache = new MemoryCache();
    const { container } = await buildTestApp({}, { cache });
    const { link } = await container.linkService.create({ originalUrl: 'https://example.com' }, ctx);
    await cache.set(`url:${link.shortCode}`, '{not json', 60);
    expect((await container.linkService.resolve(link.shortCode)).source).toBe('database');
  });

  test('works with the cache disabled', async () => {
    const { container } = await buildTestApp({ CACHE: 'none' });
    const { link } = await container.linkService.create({ originalUrl: 'https://example.com' }, ctx);
    expect((await container.linkService.resolve(link.shortCode)).source).toBe('database');
    expect((await container.linkService.resolve(link.shortCode)).source).toBe('database');
  });

  test('remove requires the right management token', async () => {
    const { container } = await buildTestApp();
    const { link, manageToken } = await container.linkService.create({ originalUrl: 'https://example.com' }, ctx);
    await expect(container.linkService.remove(link.shortCode)).rejects.toMatchObject({ status: 401 });
    await expect(container.linkService.remove(link.shortCode, 'wrong')).rejects.toMatchObject({ status: 403 });
    await container.linkService.remove(link.shortCode, manageToken);
    await expect(container.linkService.get(link.shortCode, ctx)).rejects.toMatchObject({ status: 404 });
  });

  test('checkAlias reports availability and reasons', async () => {
    const { container } = await buildTestApp();
    await container.linkService.create({ originalUrl: 'https://example.com', customAlias: 'taken-one' }, ctx);
    expect(await container.linkService.checkAlias('free-one')).toEqual({ alias: 'free-one', available: true });
    expect(await container.linkService.checkAlias('taken-one')).toMatchObject({ available: false });
    expect(await container.linkService.checkAlias('api')).toMatchObject({ available: false });
    expect(await container.linkService.checkAlias('x')).toMatchObject({ available: false });
  });

  test('monitor options are validated and require monitoring to be enabled', async () => {
    const off = await buildTestApp({ MONITOR_ENABLED: 'false' });
    await expect(
      off.container.linkService.create({ originalUrl: 'https://example.com', monitor: true }, ctx),
    ).rejects.toMatchObject({ status: 400 });

    const on = await buildTestApp({ MONITOR_ENABLED: 'true' });
    await expect(
      on.container.linkService.create({ originalUrl: 'https://example.com', monitor: true, monitorIntervalSeconds: 5 }, ctx),
    ).rejects.toMatchObject({ status: 400 });
    const { link } = await on.container.linkService.create({ originalUrl: 'https://example.com', monitor: true }, ctx);
    expect(link.monitor).toMatchObject({ enabled: true, status: 'pending', intervalSeconds: 300 });
  });
});

describe('ClickBuffer', () => {
  const makeBuffer = (overrides = {}) => {
    const config = loadConfig({ NODE_ENV: 'test', CLICK_BATCH_SIZE: '3', CLICK_QUEUE_LIMIT: '100', ...overrides });
    const clickRepo = new MemoryClickRepository();
    const urlRepo = new MemoryUrlRepository();
    const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    const metrics = createMetrics(config);
    return { buffer: new ClickBuffer({ clickRepo, urlRepo, config, logger, metrics }), clickRepo, urlRepo, logger };
  };
  const click = (code) => ({ shortCode: code, timestamp: new Date(), browser: 'Chrome', os: 'macOS', device: 'Desktop', referrer: '' });

  test('batches writes and keeps pending counts until persisted', async () => {
    const { buffer, clickRepo, urlRepo } = makeBuffer();
    await urlRepo.create({ shortCode: 'abc1234', originalUrl: 'https://example.com', manageTokenHash: 'h' });
    buffer.record(click('abc1234'));
    buffer.record(click('abc1234'));
    expect(buffer.pendingClicks('abc1234')).toBe(2);
    await buffer.flush();
    expect(buffer.pendingClicks('abc1234')).toBe(0);
    expect(clickRepo.logs).toHaveLength(2);
    expect((await urlRepo.findByCode('abc1234')).clickCount).toBe(2);
  });

  test('keeps events and retries when the database write fails', async () => {
    const { buffer, clickRepo, urlRepo, logger } = makeBuffer();
    await urlRepo.create({ shortCode: 'abc1234', originalUrl: 'https://example.com', manageTokenHash: 'h' });
    const original = clickRepo.insertMany.bind(clickRepo);
    clickRepo.insertMany = jest.fn().mockRejectedValueOnce(new Error('db down')).mockImplementation(original);

    buffer.record(click('abc1234'));
    await buffer.flush();
    expect(logger.error).toHaveBeenCalled();
    expect(buffer.pendingClicks('abc1234')).toBe(1); // still queued

    await buffer.flush(); // retry succeeds
    expect(buffer.pendingClicks('abc1234')).toBe(0);
    expect(clickRepo.logs).toHaveLength(1);
  });

  test('drops the oldest events when the queue overflows (bounded memory)', async () => {
    const { buffer } = makeBuffer({ CLICK_BATCH_SIZE: '1000', CLICK_QUEUE_LIMIT: '100' });
    for (let i = 0; i < 150; i += 1) buffer.record(click('abc1234'));
    expect(buffer.queue).toHaveLength(100);
    expect(buffer.pendingClicks('abc1234')).toBe(100);
  });

  test('stop() flushes everything before shutdown', async () => {
    const { buffer, clickRepo } = makeBuffer({ CLICK_BATCH_SIZE: '1000' });
    buffer.start();
    buffer.record(click('abc1234'));
    await buffer.stop();
    expect(clickRepo.logs).toHaveLength(1);
  });
});

describe('probeUrl', () => {
  const okHost = async () => {};
  const res = (status) => ({ status, body: { cancel: () => Promise.resolve() } });

  test('2xx/3xx => up; 5xx and 404 => down; 403 counts as reachable', async () => {
    const run = (status) => probeUrl('https://example.com', { fetchImpl: async () => res(status), assertHost: okHost });
    expect(await run(200)).toMatchObject({ ok: true, status: 200 });
    expect(await run(301)).toMatchObject({ ok: true });
    expect(await run(404)).toMatchObject({ ok: false, error: 'HTTP 404' });
    expect(await run(503)).toMatchObject({ ok: false, error: 'HTTP 503' });
    // 403 on HEAD triggers a GET retry; both 403 => reachable
    expect(await run(403)).toMatchObject({ ok: true });
  });

  test('falls back to GET when HEAD is not allowed', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(res(405)).mockResolvedValueOnce(res(200));
    const result = await probeUrl('https://example.com', { fetchImpl, assertHost: okHost });
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls.map(([, o]) => o.method)).toEqual(['HEAD', 'GET']);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual'); // never follow redirects
  });

  test('reports timeouts and network errors without throwing', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect(await probeUrl('https://x.test', { fetchImpl: async () => { throw timeout; }, assertHost: okHost })).toMatchObject({
      ok: false,
      error: 'timeout',
      status: null,
    });
    const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(await probeUrl('https://x.test', { fetchImpl: async () => { throw refused; }, assertHost: okHost })).toMatchObject({
      ok: false,
      error: 'ECONNREFUSED',
    });
  });

  test('blocks private destinations before any request is made', async () => {
    const fetchImpl = jest.fn();
    const result = await probeUrl('http://10.0.0.1/admin', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('MonitorService', () => {
  test('probes due links, records history/uptime and flips to "down" after 2 failures', async () => {
    const results = [{ ok: true, status: 200, latencyMs: 40 }, { ok: false, status: 503, latencyMs: 90, error: 'HTTP 503' }, { ok: false, status: null, latencyMs: 8000, error: 'timeout' }];
    const probe = jest.fn(async () => results.shift());
    const { container } = await buildTestApp({ MONITOR_ENABLED: 'true' }, { probe });
    const { link } = await container.linkService.create({ originalUrl: 'https://example.com', monitor: true }, ctx);
    const view = async () => (await container.linkService.get(link.shortCode, ctx)).monitor;

    await container.monitorService.runOnce();
    expect(await view()).toMatchObject({ status: 'up', checks: 1, uptimePercent: 100, lastStatusCode: 200 });

    // Not due again until the interval passes.
    expect(await container.monitorService.runOnce()).toEqual([]);

    const dueAgain = (offsetMin) => new Date(Date.now() + offsetMin * 60_000);
    await container.monitorService.runOnce(dueAgain(6));
    expect(await view()).toMatchObject({ status: 'degraded', consecutiveFailures: 1, uptimePercent: 50 });
    await container.monitorService.runOnce(dueAgain(12));
    const final = await view();
    expect(final).toMatchObject({ status: 'down', consecutiveFailures: 2, checks: 3 });
    expect(final.history).toHaveLength(3);
    expect(await container.statsService.snapshot()).toMatchObject({ monitored: 1 });
  });

  test('collapses overlapping cycles into one', async () => {
    let release;
    const probe = jest.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, latencyMs: 1 }); }));
    const { container } = await buildTestApp({ MONITOR_ENABLED: 'true' }, { probe });
    await container.linkService.create({ originalUrl: 'https://example.com', monitor: true }, ctx);
    const first = container.monitorService.runOnce();
    const second = container.monitorService.runOnce();
    expect(second).toBe(first);
    await new Promise((r) => setImmediate(r));
    release();
    await first;
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('AnalyticsService', () => {
  test('zero-fills the timeline and aggregates breakdowns', async () => {
    const { container } = await buildTestApp();
    const { link } = await container.linkService.create({ originalUrl: 'https://example.com' }, ctx);
    const now = new Date('2026-11-15T12:00:00Z');
    await container.clickRepo.insertMany([
      { shortCode: link.shortCode, timestamp: new Date('2026-11-15T09:00:00Z'), browser: 'Chrome', os: 'Windows', device: 'Desktop', referrer: 'https://twitter.com' },
      { shortCode: link.shortCode, timestamp: new Date('2026-11-15T10:00:00Z'), browser: 'Chrome', os: 'macOS', device: 'Desktop', referrer: '' },
      { shortCode: link.shortCode, timestamp: new Date('2026-11-13T10:00:00Z'), browser: 'Safari', os: 'iOS', device: 'Mobile', referrer: 'https://twitter.com' },
      { shortCode: link.shortCode, timestamp: new Date('2026-10-01T10:00:00Z'), browser: 'Firefox', os: 'Linux', device: 'Desktop', referrer: '' }, // outside window
    ]);

    const data = await container.analyticsService.get(link.shortCode, { days: 5, now });
    expect(data.timeline.map((d) => d.date)).toEqual(['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    expect(data.timeline.map((d) => d.clicks)).toEqual([0, 0, 1, 0, 2]);
    expect(data.clicksInPeriod).toBe(3);
    expect(data.clicksByBrowser).toEqual({ Chrome: 2, Safari: 1 });
    expect(data.clicksByDevice).toEqual({ Desktop: 2, Mobile: 1 });
    expect(data.topReferrers[0]).toEqual({ referrer: 'https://twitter.com', count: 2 });
    expect(data.topReferrers.map((r) => r.referrer)).toContain('Direct');
    expect(data.recentClicks[0].timestamp.toISOString()).toBe('2026-11-15T10:00:00.000Z');
  });

  test('validates the days parameter', async () => {
    const { container } = await buildTestApp();
    expect(container.analyticsService.parseDays(undefined)).toBe(7);
    expect(container.analyticsService.parseDays('30')).toBe(30);
    expect(() => container.analyticsService.parseDays('0')).toThrow(/between 1 and 90/);
    expect(() => container.analyticsService.parseDays('91')).toThrow();
    expect(() => container.analyticsService.parseDays('x')).toThrow();
  });
});
