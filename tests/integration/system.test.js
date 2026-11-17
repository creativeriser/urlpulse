'use strict';

const { buildTestApp } = require('../helpers/testApp');
const { MemoryCache } = require('../../src/adapters/cache/memoryCache');
const { MemoryUrlRepository } = require('../../src/adapters/memory/urlRepository');
const { MemoryClickRepository } = require('../../src/adapters/memory/clickRepository');

describe('health endpoints', () => {
  test('/livez is dependency-free; /health reports dependencies', async () => {
    const { http } = await buildTestApp();
    expect((await http.get('/livez')).body).toEqual({ status: 'alive' });

    const res = await http.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'UP', mongo: 'memory', redis: 'memory' });
    expect(res.body.timestamp).toBeTruthy();
    expect(res.body.checks.mongo.up).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('503 DOWN when the database is unreachable', async () => {
    const urlRepo = new MemoryUrlRepository();
    urlRepo.ping = async () => { throw new Error('ECONNREFUSED'); };
    const { http } = await buildTestApp({}, { urlRepo, clickRepo: new MemoryClickRepository() });
    const res = await http.get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'DOWN', mongo: 'disconnected' });
  });

  test('cache outage => DEGRADED but still 200 (redirects keep working from the database)', async () => {
    const cache = new MemoryCache();
    cache.ping = async () => { throw new Error('redis down'); };
    const { http, container } = await buildTestApp({ CACHE: 'redis', REDIS_URL: 'redis://unused:6379' }, { cache });
    const res = await http.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'DEGRADED', redis: 'disconnected' });

    // The redirect path must still work with a cache that errors on every call.
    cache.get = async () => null;
    const created = await http.post('/api/url/shorten').send({ originalUrl: 'https://example.com' });
    expect((await http.get(`/${created.body.shortCode}`).redirects(0)).status).toBe(302);
    expect(container.state.draining).toBe(false);
  });

  test('503 DRAINING during shutdown so load balancers stop routing traffic', async () => {
    const { http, container } = await buildTestApp();
    await http.get('/health'); // build state
    container.state.draining = true;
    const res = await http.get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('DRAINING');
  });
});

describe('GET /metrics', () => {
  test('exposes Prometheus metrics with route-pattern labels (bounded cardinality)', async () => {
    const { http } = await buildTestApp();
    const created = await http.post('/api/url/shorten').send({ originalUrl: 'https://example.com' });
    await http.get(`/${created.body.shortCode}`).redirects(0); // miss
    await http.get(`/${created.body.shortCode}`).redirects(0); // hit
    await http.get('/api/url/nothere1'); // 404 through the API

    const res = await http.get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const text = res.text;
    expect(text).toMatch(/http_requests_total\{method="GET",route="\/:shortCode",status_code="302"\} 2/);
    expect(text).toMatch(/http_requests_total\{method="POST",route="\/api\/url\/shorten",status_code="201"\} 1/);
    expect(text).toMatch(/http_request_duration_seconds_bucket\{le="0\.01"/);
    expect(text).toMatch(/urlpulse_redirect_cache_hits_total 1/);
    expect(text).toMatch(/urlpulse_redirect_cache_misses_total 1/);
    expect(text).toMatch(/urlpulse_redirects_total\{outcome="found"\} 2/);
    expect(text).toMatch(/urlpulse_links_created_total\{type="random"\} 1/);
    expect(text).toMatch(/urlpulse_links 1/);
    expect(text).toMatch(/urlpulse_dependency_up\{dependency="mongo"\} 1/);
    expect(text).toMatch(/urlpulse_build_info\{version="1\.0\.0"/);
    expect(text).toContain('nodejs_heap_size_used_bytes');
    expect(text).toContain('process_cpu_user_seconds_total');
    // the short code itself must never become a label value
    expect(text).not.toContain(created.body.shortCode);
  });

  test('can be protected with a bearer token and switched off', async () => {
    const guarded = await buildTestApp({ METRICS_TOKEN: 's3cret-token-value' });
    expect((await guarded.http.get('/metrics')).status).toBe(401);
    expect((await guarded.http.get('/metrics').set('Authorization', 'Bearer nope')).status).toBe(401);
    expect((await guarded.http.get('/metrics').set('Authorization', 'Bearer s3cret-token-value')).status).toBe(200);

    const off = await buildTestApp({ METRICS_ENABLED: 'false' });
    expect((await off.http.get('/metrics')).status).toBe(404);
  });
});

describe('GET /api/stats', () => {
  test('returns global counters and cache efficiency', async () => {
    const { http, container } = await buildTestApp();
    const a = await http.post('/api/url/shorten').send({ originalUrl: 'https://example.com/a' });
    await http.get(`/${a.body.shortCode}`).redirects(0);
    await http.get(`/${a.body.shortCode}`).redirects(0);
    await container.clickBuffer.flush();
    container.statsService.cached = null; // bypass the 10s snapshot cache

    const res = await http.get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, links: 1, clicks: 2, monitoredLinks: 0, version: '1.0.0' });
    expect(res.body.cache).toEqual({ hits: 1, misses: 1, hitRatio: 0.5 });
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('security & hardening', () => {
  test('sets strict security headers and a locked-down CSP', async () => {
    const { http } = await buildTestApp();
    const res = await http.get('/');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  test('every response carries a correlation id, and an inbound one is preserved', async () => {
    const { http } = await buildTestApp();
    expect((await http.get('/livez')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await http.get('/livez').set('X-Request-Id', 'trace-123')).headers['x-request-id']).toBe('trace-123');
  });

  test('unknown API routes return a JSON 404 (never HTML)', async () => {
    const { http } = await buildTestApp();
    const res = await http.get('/api/does/not/exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  test('rate limiting: 429 with standard headers after the write quota is exhausted', async () => {
    const { http } = await buildTestApp({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '3' });
    const send = () => http.post('/api/url/shorten').send({ originalUrl: 'https://example.com' });
    for (let i = 0; i < 3; i += 1) expect((await send()).status).toBe(201);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['ratelimit']).toBeDefined();
    // reads use their own, larger bucket and are unaffected
    expect((await http.get('/api/stats')).status).toBe(200);
  });

  test('CORS is off by default and opt-in via CORS_ORIGIN', async () => {
    const off = await buildTestApp();
    expect((await off.http.get('/api/stats').set('Origin', 'https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
    const on = await buildTestApp({ CORS_ORIGIN: 'https://app.example' });
    expect((await on.http.get('/api/stats').set('Origin', 'https://app.example')).headers['access-control-allow-origin']).toBe('https://app.example');
  });

  test('unhandled errors become a generic 500 without leaking internals', async () => {
    const { http, container } = await buildTestApp();
    jest.spyOn(container.linkService, 'create').mockRejectedValue(new Error('secret db password in stack'));
    const res = await http.post('/api/url/shorten').send({ originalUrl: 'https://example.com' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('static site', () => {
  test.each(['/', '/dashboard', '/status'])('serves %s as HTML', async (path) => {
    const { http } = await buildTestApp();
    const res = await http.get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  test('unknown pages get the branded 404', async () => {
    const { http } = await buildTestApp();
    const res = await http.get('/some/where/else').set('Accept', 'text/html');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
