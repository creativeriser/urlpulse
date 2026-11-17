'use strict';

const { buildTestApp } = require('../helpers/testApp');

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

describe('POST /api/url/shorten', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  test('201 with a 7-char Base62 code, full short URL and a one-time manage token', async () => {
    const res = await ctx.http.post('/api/url/shorten').send({ originalUrl: 'https://example.com/very/long?ref=capstone' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      originalUrl: 'https://example.com/very/long?ref=capstone',
      expiresAt: null,
    });
    expect(res.body.shortCode).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(res.body.shortUrl).toBe(`http://short.test/${res.body.shortCode}`);
    expect(res.body.qrUrl).toBe(`http://short.test/api/url/${res.body.shortCode}/qr`);
    expect(res.body.manageToken.length).toBeGreaterThanOrEqual(32);
    expect(res.headers.location).toContain(`/api/url/${res.body.shortCode}`);
    expect(JSON.stringify(res.body)).not.toMatch(/manageTokenHash/);
  });

  test('custom alias is honoured; duplicate returns 409', async () => {
    const first = await ctx.http.post('/api/url/shorten').send({ originalUrl: 'https://example.com', customAlias: 'my-portfolio' });
    expect(first.status).toBe(201);
    expect(first.body.shortUrl).toBe('http://short.test/my-portfolio');

    const dup = await ctx.http.post('/api/url/shorten').send({ originalUrl: 'https://example.org', customAlias: 'my-portfolio' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ success: false, error: { code: 'ALIAS_TAKEN' } });
  });

  test.each([
    [{}, 'missing url'],
    [{ originalUrl: 'ftp://example.com' }, 'bad scheme'],
    [{ originalUrl: 'javascript:alert(1)' }, 'javascript url'],
    [{ originalUrl: 'http://localhost:5000' }, 'localhost'],
    [{ originalUrl: 'http://short.test/abc1234' }, 'self reference'],
    [{ originalUrl: 'https://example.com', customAlias: 'a' }, 'short alias'],
    [{ originalUrl: 'https://example.com', customAlias: 'api' }, 'reserved alias'],
    [{ originalUrl: 'https://example.com', expiresInDays: 9999 }, 'expiry too far'],
  ])('400 for %j (%s)', async (payload) => {
    const res = await ctx.http.post('/api/url/shorten').send(payload);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
  });

  test('400 for malformed JSON and tolerant of non-JSON content types', async () => {
    const bad = await ctx.http.post('/api/url/shorten').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');

    const form = await ctx.http.post('/api/url/shorten').type('form').send('originalUrl=https://example.com');
    expect(form.status).toBe(400); // body ignored => originalUrl missing, not a 500
  });

  test('413 for oversized bodies', async () => {
    const res = await ctx.http.post('/api/url/shorten').send({ originalUrl: `https://example.com/${'a'.repeat(20_000)}` });
    expect(res.status).toBe(413);
  });

  test('stores an expiry when requested', async () => {
    const res = await ctx.http.post('/api/url/shorten').send({ originalUrl: 'https://example.com', expiresInDays: 7 });
    expect(res.status).toBe(201);
    const days = (new Date(res.body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});

describe('GET /:shortCode (redirect)', () => {
  let ctx;
  let code;
  beforeEach(async () => {
    ctx = await buildTestApp();
    const res = await ctx.http.post('/api/url/shorten').send({ originalUrl: 'https://example.com/landing?x=1' });
    code = res.body.shortCode;
  });

  test('302 with the Location header and no-store caching', async () => {
    const res = await ctx.http.get(`/${code}`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/landing?x=1');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('unknown code => 404 HTML page for browsers, JSON for API clients', async () => {
    const html = await ctx.http.get('/zzzzzzz').set('Accept', 'text/html');
    expect(html.status).toBe(404);
    expect(html.headers['content-type']).toMatch(/html/);

    const json = await ctx.http.get('/zzzzzzz').set('Accept', 'application/json');
    expect(json.status).toBe(404);
    expect(json.body.error.code).toBe('NOT_FOUND');
  });

  test('expired link => 410', async () => {
    const created = await ctx.http.post('/api/url/shorten').send({ originalUrl: 'https://example.com', expiresInDays: 1 });
    const record = await ctx.container.urlRepo.findByCode(created.body.shortCode);
    record.expiresAt = new Date(Date.now() - 1000);
    ctx.container.urlRepo.records.get(created.body.shortCode).expiresAt = record.expiresAt;
    await ctx.container.cache.del(`url:${created.body.shortCode}`);

    const res = await ctx.http.get(`/${created.body.shortCode}`).set('Accept', 'text/html');
    expect(res.status).toBe(410);
  });

  test('reserved / dotted paths never hit the redirect logic', async () => {
    const spy = jest.spyOn(ctx.container.linkService, 'resolve');
    await ctx.http.get('/dashboard');
    await ctx.http.get('/robots.txt');
    expect(spy).not.toHaveBeenCalled();
  });

  test('records click analytics (browser, os, device, referrer origin) asynchronously', async () => {
    await ctx.http.get(`/${code}`).set('User-Agent', CHROME).set('Referer', 'https://twitter.com/some/post?secret=1').redirects(0);
    await ctx.http.get(`/${code}`).set('User-Agent', 'curl/8.5.0').redirects(0);

    // Pending clicks are visible immediately, before the flush...
    const info = await ctx.http.get(`/api/url/${code}`);
    expect(info.body.clickCount).toBe(2);

    await ctx.container.clickBuffer.flush();
    const stored = ctx.container.clickRepo.logs;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ browser: 'Chrome', os: 'Windows', device: 'Desktop', referrer: 'https://twitter.com' });
    expect(stored[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toMatch(/127\.0\.0\.1|::ffff/); // raw IP is never stored
    expect(stored[1]).toMatchObject({ browser: 'CLI', device: 'Bot' });
  });

  test('analytics endpoint reports totals, breakdowns and a zero-filled timeline', async () => {
    await ctx.http.get(`/${code}`).set('User-Agent', CHROME).redirects(0);
    await ctx.http.get(`/${code}`).set('User-Agent', CHROME).redirects(0);
    await ctx.container.clickBuffer.flush();

    const res = await ctx.http.get(`/api/analytics/${code}?days=3`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      shortCode: code,
      totalClicks: 2,
      clicksInPeriod: 2,
      periodDays: 3,
      clicksByBrowser: { Chrome: 2 },
      clicksByOS: { Windows: 2 },
      clicksByDevice: { Desktop: 2 },
    });
    expect(res.body.timeline).toHaveLength(3);
    expect(res.body.timeline.at(-1).clicks).toBe(2);
    expect(res.body.topReferrers).toEqual([{ referrer: 'Direct', count: 2 }]);

    expect((await ctx.http.get('/api/analytics/nope1234')).status).toBe(404);
    expect((await ctx.http.get(`/api/analytics/${code}?days=500`)).status).toBe(400);
  });
});

describe('link management (X-Manage-Token)', () => {
  test('DELETE needs the token; success removes the link, its analytics and its cache entry', async () => {
    const { http, container } = await buildTestApp();
    const created = await http.post('/api/url/shorten').send({ originalUrl: 'https://example.com' });
    const { shortCode, manageToken } = created.body;
    await http.get(`/${shortCode}`).redirects(0); // warm cache + click

    expect((await http.delete(`/api/url/${shortCode}`)).status).toBe(401);
    expect((await http.delete(`/api/url/${shortCode}`).set('X-Manage-Token', 'wrong')).status).toBe(403);
    expect((await http.get(`/${shortCode}`).redirects(0)).status).toBe(302); // still alive

    await container.clickBuffer.flush();
    expect((await http.delete(`/api/url/${shortCode}`).set('X-Manage-Token', manageToken)).status).toBe(204);
    expect((await http.get(`/${shortCode}`).set('Accept', 'application/json')).status).toBe(404);
    expect(container.clickRepo.logs.filter((l) => l.shortCode === shortCode)).toHaveLength(0);
    expect((await http.delete(`/api/url/${shortCode}`).set('X-Manage-Token', manageToken)).status).toBe(404);
  });

  test('GET /api/availability/:alias', async () => {
    const { http } = await buildTestApp();
    await http.post('/api/url/shorten').send({ originalUrl: 'https://example.com', customAlias: 'taken-name' });
    expect((await http.get('/api/availability/free-name')).body).toMatchObject({ available: true });
    expect((await http.get('/api/availability/taken-name')).body).toMatchObject({ available: false });
    expect((await http.get('/api/availability/admin')).body).toMatchObject({ available: false });
  });

  test('GET /api/url/:code returns public info only', async () => {
    const { http } = await buildTestApp();
    const created = await http.post('/api/url/shorten').send({ originalUrl: 'https://example.com' });
    const res = await http.get(`/api/url/${created.body.shortCode}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ shortCode: created.body.shortCode, clickCount: 0, monitor: { enabled: false, status: 'off' } });
    expect(res.body).not.toHaveProperty('manageToken');
    expect((await http.get('/api/url/does-not-exist')).status).toBe(404);
  });

  test('QR endpoint serves SVG and PNG', async () => {
    const { http } = await buildTestApp();
    const { body } = await http.post('/api/url/shorten').send({ originalUrl: 'https://example.com' });

    const binary = (res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };

    const svg = await http.get(`/api/url/${body.shortCode}/qr`).buffer(true).parse(binary);
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(svg.body.toString()).toContain('<svg');

    const png = await http.get(`/api/url/${body.shortCode}/qr?format=png&size=256&download=1`).buffer(true).parse(binary);
    expect(png.headers['content-type']).toMatch(/image\/png/);
    expect(png.headers['content-disposition']).toContain(`urlpulse-${body.shortCode}.png`);
    expect(png.body.subarray(1, 4).toString()).toBe('PNG');

    expect((await http.get('/api/url/nothere1/qr')).status).toBe(404);
  });
});

describe('uptime monitoring over HTTP', () => {
  test('create with monitor, probe, then toggle with the token', async () => {
    const probe = jest.fn(async () => ({ ok: true, status: 200, latencyMs: 55 }));
    const { http, container } = await buildTestApp({ MONITOR_ENABLED: 'true' }, { probe });

    const created = await http.post('/api/url/shorten').send({ originalUrl: 'https://example.com', monitor: true, monitorIntervalSeconds: 60 });
    expect(created.status).toBe(201);
    expect(created.body.link.monitor).toMatchObject({ enabled: true, status: 'pending', intervalSeconds: 60 });

    await container.monitorService.runOnce();
    const info = await http.get(`/api/url/${created.body.shortCode}`);
    expect(info.body.monitor).toMatchObject({ status: 'up', lastStatusCode: 200, lastLatencyMs: 55, uptimePercent: 100 });
    expect(info.body.monitor.history).toHaveLength(1);

    const { shortCode, manageToken } = created.body;
    expect((await http.patch(`/api/url/${shortCode}/monitor`).send({ enabled: false })).status).toBe(401);
    const off = await http.patch(`/api/url/${shortCode}/monitor`).set('X-Manage-Token', manageToken).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.monitor.status).toBe('off');
    expect(await container.monitorService.runOnce(new Date(Date.now() + 3_600_000))).toEqual([]);

    expect((await http.patch(`/api/url/${shortCode}/monitor`).set('X-Manage-Token', manageToken).send({ enabled: 'yes' })).status).toBe(400);
  });
});
