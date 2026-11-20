'use strict';

const { generateCode, ALPHABET } = require('../../src/lib/base62');
const { parseUserAgent } = require('../../src/lib/userAgent');
const { hashIp, tokenMatches, sha256, generateManageToken, referrerOrigin } = require('../../src/lib/crypto');
const { isPrivateIp, isBlockedHostname, assertPublicHost } = require('../../src/lib/network');

describe('base62 generateCode', () => {
  test('produces the requested length using only Base62 characters', () => {
    const code = generateCode(7);
    expect(code).toHaveLength(7);
    expect([...code].every((c) => ALPHABET.includes(c))).toBe(true);
    expect(generateCode(12)).toHaveLength(12);
  });

  test('is collision-resistant in practice (20k codes, no duplicates)', () => {
    const seen = new Set();
    for (let i = 0; i < 20_000; i += 1) seen.add(generateCode(7));
    expect(seen.size).toBe(20_000);
  });
});

describe('parseUserAgent', () => {
  const cases = [
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      { browser: 'Chrome', os: 'Windows', device: 'Desktop' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Edg/124.0',
      { browser: 'Edge', os: 'Windows', device: 'Desktop' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      { browser: 'Safari', os: 'macOS', device: 'Desktop' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iOS', device: 'Mobile' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36',
      { browser: 'Chrome', os: 'Android', device: 'Mobile' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      { browser: 'Chrome', os: 'Android', device: 'Tablet' },
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0', { browser: 'Firefox', os: 'Linux', device: 'Desktop' }],
    ['curl/8.5.0', { browser: 'CLI', os: 'Unknown', device: 'Bot' }],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', { browser: 'Bot', device: 'Bot' }],
  ];

  test.each(cases)('classifies %s', (ua, expected) => {
    expect(parseUserAgent(ua)).toMatchObject(expected);
  });

  test('handles empty / missing input', () => {
    expect(parseUserAgent('')).toEqual({ browser: 'Unknown', os: 'Unknown', device: 'Unknown' });
    expect(parseUserAgent()).toMatchObject({ browser: 'Unknown' });
  });
});

describe('crypto helpers', () => {
  test('hashIp is deterministic, salted and never returns the raw IP', () => {
    const a = hashIp('203.0.113.9', 'salt-1');
    expect(a).toBe(hashIp('203.0.113.9', 'salt-1'));
    expect(a).not.toBe(hashIp('203.0.113.9', 'salt-2'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('203');
  });

  test('manage tokens verify in constant time and reject wrong / missing values', () => {
    const token = generateManageToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    const stored = sha256(token);
    expect(tokenMatches(token, stored)).toBe(true);
    expect(tokenMatches(`${token}x`, stored)).toBe(false);
    expect(tokenMatches('', stored)).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
  });

  test('referrerOrigin strips path and query', () => {
    expect(referrerOrigin('https://news.example.com/a/b?token=secret#x')).toBe('https://news.example.com');
    expect(referrerOrigin('')).toBe('');
    expect(referrerOrigin('not a url')).toBe('');
  });
});

describe('network guards', () => {
  test.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.5.5', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata endpoint
    ['100.64.0.1', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['::ffff:127.0.0.1', true],
    ['2606:4700:4700::1111', false],
    ['::ffff:8.8.8.8', false], // IPv4-mapped public address
    // IPv6 forms that embed an IPv4 address: judged by the embedded address
    ['::', true],
    ['::127.0.0.1', true], // IPv4-compatible
    ['::a00:1', true],
    ['64:ff9b::7f00:1', true], // NAT64 -> 127.0.0.1
    ['64:ff9b::a9fe:a9fe', true], // NAT64 -> 169.254.169.254 (metadata)
    ['64:ff9b::808:808', false], // NAT64 -> 8.8.8.8
    ['64:ff9b:1::1', true], // local-use NAT64
    ['2002:7f00:1::', true], // 6to4 -> 127.0.0.1
    ['2002:a9fe:a9fe::1', true], // 6to4 -> 169.254.169.254
    ['2002:808:808::', false], // 6to4 -> 8.8.8.8
    ['fe80::1%eth0', true],
  ])('isPrivateIp(%s) === %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  test.each([
    ['localhost', true],
    ['LOCALHOST.', true],
    ['db.internal', true],
    ['printer.local', true],
    ['[::1]', true],
    ['127.0.0.1', true],
    ['example.com', false],
    ['sub.example.co.uk', false],
  ])('isBlockedHostname(%s) === %s', (host, expected) => {
    expect(isBlockedHostname(host)).toBe(expected);
  });

  test('assertPublicHost rejects hosts that resolve to private addresses (SSRF)', async () => {
    const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];
    const mixedLookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

    await expect(assertPublicHost('evil.example', privateLookup)).rejects.toThrow(/private/);
    await expect(assertPublicHost('rebind.example', mixedLookup)).rejects.toThrow(/private/);
    await expect(assertPublicHost('example.com', publicLookup)).resolves.toBeUndefined();
    await expect(assertPublicHost('localhost', publicLookup)).rejects.toThrow(/not allowed/);
  });
});
