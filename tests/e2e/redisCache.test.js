'use strict';

/**
 * Exercises the REAL Redis adapter. Skipped unless REDIS_URL is set
 * (CI provides a Redis service container; locally: `docker compose up -d redis` and use the password from .env: REDIS_URL=redis://:<password>@127.0.0.1:6379).
 */
const { RedisCache } = require('../../src/adapters/cache/redisCache');

const REDIS_URL = process.env.REDIS_URL;
const describeIf = REDIS_URL ? describe : describe.skip;

describeIf('RedisCache (real Redis)', () => {
  let cache;
  const key = `urlpulse-test:${Date.now()}`;

  beforeAll(async () => {
    cache = new RedisCache(REDIS_URL, { logger: { info() {}, warn() {} } });
    await cache.connect();
  });

  afterAll(async () => {
    await cache.del(key);
    await cache.close();
  });

  test('set / get / del round-trip with TTL', async () => {
    await cache.set(key, 'hello', 30);
    expect(await cache.get(key)).toBe('hello');
    const ttl = await cache.client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
    await cache.del(key);
    expect(await cache.get(key)).toBeNull();
  });

  test('ping reports latency', async () => {
    expect(await cache.ping()).toBeGreaterThanOrEqual(0);
    expect(cache.isReady()).toBe(true);
  });

  test('is fail-safe: operations on a dead connection behave like cache misses', async () => {
    const dead = new RedisCache('redis://127.0.0.1:1', { logger: { info() {}, warn() {} } });
    await dead.connect(); // must not throw
    expect(await dead.get('x')).toBeNull();
    await expect(dead.set('x', '1', 10)).resolves.toBeUndefined();
    await expect(dead.del('x')).resolves.toBeUndefined();
    await expect(dead.ping()).rejects.toThrow();
    await dead.close();
  });
});
