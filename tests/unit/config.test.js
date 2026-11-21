'use strict';

const { loadConfig } = require('../../src/config');

describe('loadConfig', () => {
  test('defaults to zero-dependency memory mode', () => {
    const c = loadConfig({ NODE_ENV: 'development' });
    expect(c.storage).toBe('memory');
    expect(c.cache).toBe('memory');
    expect(c.port).toBe(5000);
    expect(c.rateLimit.writeMax).toBe(100); // spec: 100 requests / 15 min
    expect(c.rateLimit.windowMs).toBe(15 * 60 * 1000);
    expect(c.rateLimit.publicMax).toBe(600);
    expect(c.rateLimit.publicWindowMs).toBe(60 * 1000);
    expect(c.corsOrigin).toBe(''); // CORS off by default
  });

  test('CORS_ORIGIN: trims a list and refuses a wildcard', () => {
    expect(loadConfig({ NODE_ENV: 'test', CORS_ORIGIN: ' https://a.example , https://b.example ' }).corsOrigin).toBe('https://a.example,https://b.example');
    expect(() => loadConfig({ NODE_ENV: 'test', CORS_ORIGIN: '*' })).toThrow(/CORS_ORIGIN/);
    expect(() => loadConfig({ NODE_ENV: 'test', CORS_ORIGIN: 'https://a.example,*' })).toThrow(/CORS_ORIGIN/);
  });

  test('commit: BUILD_SHA wins, the Dockerfile default "dev" is treated as unset, RENDER_GIT_COMMIT is the fallback', () => {
    expect(loadConfig({ NODE_ENV: 'test', BUILD_SHA: 'abc123' }).commit).toBe('abc123');
    expect(loadConfig({ NODE_ENV: 'test', BUILD_SHA: 'abc123', RENDER_GIT_COMMIT: 'def456' }).commit).toBe('abc123');
    expect(loadConfig({ NODE_ENV: 'test', BUILD_SHA: 'dev', RENDER_GIT_COMMIT: 'def456' }).commit).toBe('def456');
    expect(loadConfig({ NODE_ENV: 'test', RENDER_GIT_COMMIT: 'def456' }).commit).toBe('def456');
    expect(loadConfig({ NODE_ENV: 'test' }).commit).toBe('dev');
    expect(loadConfig({ NODE_ENV: 'test', BUILD_SHA: 'dev' }).commit).toBe('dev');
  });

  test('infers mongo + redis from connection settings', () => {
    const c = loadConfig({
      NODE_ENV: 'development',
      MONGO_URI: 'mongodb://mongo:27017/urlpulse',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6380',
    });
    expect(c.storage).toBe('mongo');
    expect(c.cache).toBe('redis');
    expect(c.redisUrl).toBe('redis://redis:6380');
  });

  test('strips trailing slashes from BASE_URL and parses booleans / numbers', () => {
    const c = loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://sho.rt///', ALLOW_PRIVATE_TARGETS: 'true', PORT: '8080' });
    expect(c.baseUrl).toBe('https://sho.rt');
    expect(c.allowPrivateTargets).toBe(true);
    expect(c.port).toBe(8080);
  });

  test('production refuses to start without a real HASH_SALT', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/HASH_SALT/);
    expect(() => loadConfig({ NODE_ENV: 'production', HASH_SALT: 'short' })).toThrow(/HASH_SALT/);
    expect(loadConfig({ NODE_ENV: 'production', HASH_SALT: 'x'.repeat(24) }).isProduction).toBe(true);
  });

  test('rejects inconsistent settings', () => {
    expect(() => loadConfig({ STORAGE: 'mongo' })).toThrow(/MONGO_URI/);
    expect(() => loadConfig({ CACHE: 'redis' })).toThrow(/REDIS/);
    expect(() => loadConfig({ STORAGE: 'sqlite' })).toThrow(/STORAGE/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/integer/);
  });

  test('configuration object is immutable', () => {
    const c = loadConfig({ NODE_ENV: 'test' });
    expect(Object.isFrozen(c)).toBe(true);
  });
});
