'use strict';

/**
 * Full-stack test: the real application wired to REAL MongoDB + Redis.
 * Skipped unless both MONGO_URI and REDIS_URL are set.
 */

const request = require('supertest');
const { loadConfig } = require('../../src/config');
const { createContainer } = require('../../src/container');
const { createApp } = require('../../src/app');

const { MONGO_URI, REDIS_URL } = process.env;
const describeIf = MONGO_URI && REDIS_URL ? describe : describe.skip;

describeIf('URLPulse on real MongoDB + Redis', () => {
  let container;
  let http;

  beforeAll(async () => {
    const dbName = `urlpulse_e2e_${Date.now()}`;
    const uri = MONGO_URI.includes('?')
      ? MONGO_URI.replace(/\/([^/?]*)\?/, `/${dbName}?`)
      : `${MONGO_URI.replace(/\/[^/]*$/, '')}/${dbName}`;

    const config = loadConfig({
      NODE_ENV: 'test',
      MONGO_URI: uri,
      REDIS_URL,
      BASE_URL: 'http://short.test',
      MONITOR_ENABLED: 'true',
    });

    container = await createContainer(config, {
      probe: async () => ({ ok: true, status: 200, latencyMs: 12 }),
    });

    const app = createApp(container);
    http = request(app);
  });

  afterAll(async () => {
    if (!container) return;

    try {
      await container.urlRepo.connection?.dropDatabase?.();
    } finally {
      await container.close();
    }
  });

  test('health reports both dependencies connected', async () => {
    const res = await http.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'UP',
      mongo: 'connected',
      redis: 'connected',
    });
  });

  test('shorten -> redirect (miss, then Redis hit) -> persisted analytics', async () => {
    const created = await http.post('/api/url/shorten').send({
      originalUrl: 'https://example.com/e2e',
      customAlias: 'e2e-link',
    });
    expect(created.status).toBe(201);

    const first = await http
      .get('/e2e-link')
      .set(
        'User-Agent',
        'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
      )
      .redirects(0);

    expect(first.status).toBe(302);
    await http.get('/e2e-link').redirects(0);

    expect(container.metrics.runtime).toMatchObject({
      cacheMisses: 1,
      cacheHits: 1,
    });

    expect(await container.cache.get('url:e2e-link')).toContain(
      'https://example.com/e2e',
    );

    await container.clickBuffer.flush();

    const analytics = await http.get('/api/analytics/e2e-link?days=7');

    expect(analytics.status).toBe(200);
    expect(analytics.body.totalClicks).toBe(2);
    expect(analytics.body.clicksInPeriod).toBe(2);
    expect(analytics.body.clicksByBrowser.Firefox).toBe(1);
    expect(analytics.body.timeline).toHaveLength(7);
  });

  test('unique index rejects duplicate aliases', async () => {
    const dup = await http.post('/api/url/shorten').send({
      originalUrl: 'https://example.org',
      customAlias: 'e2e-link',
    });

    expect(dup.status).toBe(409);
  });

  test('uptime monitor claims, probes and records history in MongoDB', async () => {
    const created = await http.post('/api/url/shorten').send({
      originalUrl: 'https://example.com/m',
      monitor: true,
    });

    const results = await container.monitorService.runOnce();

    expect(results.map((r) => r.shortCode)).toContain(created.body.shortCode);

    const info = await http.get(`/api/url/${created.body.shortCode}`);

    expect(info.body.monitor).toMatchObject({
      status: 'up',
      checks: 1,
      uptimePercent: 100,
    });

    expect(info.body.monitor.history).toHaveLength(1);

    // A second cycle right away must not re-claim the URL.
    expect(await container.monitorService.runOnce()).toEqual([]);
  });

  test('delete removes the link, its click logs and its cache entry', async () => {
    const created = await http.post('/api/url/shorten').send({
      originalUrl: 'https://example.com/d',
    });

    await http.get(`/${created.body.shortCode}`).redirects(0);
    await container.clickBuffer.flush();

    const del = await http
      .delete(`/api/url/${created.body.shortCode}`)
      .set('X-Manage-Token', created.body.manageToken);

    expect(del.status).toBe(204);
    expect(
      await container.cache.get(`url:${created.body.shortCode}`),
    ).toBeNull();
    expect((await http.get(`/api/url/${created.body.shortCode}`)).status).toBe(
      404,
    );
  });
});
