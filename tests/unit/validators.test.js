'use strict';

const { validateAlias, validateTargetUrl, resolveExpiry, isReserved } = require('../../src/lib/validators');

const opts = { maxLength: 2048, allowPrivateTargets: false, selfHosts: ['short.test'] };

describe('validateAlias', () => {
  test.each(['my-portfolio', 'abc', 'Pulse89', 'a1-b2-c3'])('accepts %s', (alias) => {
    expect(validateAlias(alias)).toBe(alias);
  });

  test.each([
    ['ab', 'too short'],
    ['a'.repeat(31), 'too long'],
    ['-leading', 'leading hyphen'],
    ['trailing-', 'trailing hyphen'],
    ['has space', 'space'],
    ['under_score', 'underscore'],
    ['emoji🙂', 'emoji'],
    ['../etc', 'path traversal'],
    [123, 'non-string'],
  ])('rejects %p (%s)', (alias) => {
    expect(() => validateAlias(alias)).toThrow(expect.objectContaining({ status: 400, code: 'VALIDATION_ERROR' }));
  });

  test('rejects reserved route names case-insensitively', () => {
    expect(isReserved('API')).toBe(true);
    expect(() => validateAlias('dashboard')).toThrow(/reserved/);
    expect(() => validateAlias('Metrics')).toThrow(/reserved/);
  });
});

describe('validateTargetUrl', () => {
  test('normalises a valid URL', () => {
    expect(validateTargetUrl('  https://Example.com/a?b=1 ', opts)).toBe('https://example.com/a?b=1');
  });

  test.each([
    ['', 'empty'],
    ['not a url', 'garbage'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['data:text/html,<script>alert(1)</script>', 'data scheme'],
    ['ftp://example.com/file', 'ftp scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['https://user:pass@example.com', 'embedded credentials'],
    ['http://localhost:3000/admin', 'localhost'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://2130706433/', 'decimal-encoded loopback'],
    ['http://0x7f.0.0.1/', 'hex-encoded loopback'],
    ['http://169.254.169.254/latest/meta-data', 'cloud metadata'],
    ['http://[::1]/', 'ipv6 loopback'],
    ['http://intranet.internal/', '.internal host'],
    ['http://short.test/abc', 'self (redirect loop)'],
    [`https://example.com/${'a'.repeat(3000)}`, 'too long'],
  ])('rejects %p (%s)', (url) => {
    expect(() => validateTargetUrl(url, opts)).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('allows private targets when explicitly enabled (dev mode)', () => {
    expect(validateTargetUrl('http://localhost:3000/x', { ...opts, allowPrivateTargets: true })).toBe(
      'http://localhost:3000/x',
    );
  });
});

describe('resolveExpiry', () => {
  const now = new Date('2026-11-15T10:00:00Z');

  test('returns null when nothing requested', () => {
    expect(resolveExpiry({}, now)).toBeNull();
    expect(resolveExpiry({ expiresInDays: '' }, now)).toBeNull();
  });

  test('computes expiry from days', () => {
    expect(resolveExpiry({ expiresInDays: 7 }, now).toISOString()).toBe('2026-11-22T10:00:00.000Z');
  });

  test('accepts a future ISO date', () => {
    expect(resolveExpiry({ expiresAt: '2026-12-01T00:00:00Z' }, now).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  test.each([
    [{ expiresInDays: 0 }],
    [{ expiresInDays: 366 }],
    [{ expiresInDays: 1.5 }],
    [{ expiresInDays: 'abc' }],
    [{ expiresAt: 'yesterday' }],
    [{ expiresAt: '2020-01-01T00:00:00Z' }],
    [{ expiresAt: '2030-01-01T00:00:00Z' }],
    [{ expiresInDays: 3, expiresAt: '2026-12-01T00:00:00Z' }],
  ])('rejects %j', (input) => {
    expect(() => resolveExpiry(input, now)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
