'use strict';

const crypto = require('node:crypto');

/** Salted SHA-256 of an IP address: lets us count unique visitors without storing PII. */
function hashIp(ip, salt) {
  return crypto.createHash('sha256').update(`${salt}:${ip || 'unknown'}`).digest('hex');
}

/** Opaque, URL-safe secret that lets a creator manage (delete / monitor) their own link. */
function generateManageToken() {
  return crypto.randomBytes(24).toString('base64url');
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Constant-time comparison of a presented token against a stored SHA-256 digest. */
function tokenMatches(presentedToken, storedHash) {
  if (!presentedToken || !storedHash) return false;
  const a = Buffer.from(sha256(presentedToken), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Reduce a Referer header to its origin (no path / query => no leaked tokens). */
function referrerOrigin(referer) {
  if (!referer) return '';
  try {
    const { origin } = new URL(referer);
    return origin === 'null' ? '' : origin.slice(0, 200);
  } catch {
    return '';
  }
}

module.exports = { hashIp, generateManageToken, sha256, tokenMatches, referrerOrigin };
