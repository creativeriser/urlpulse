'use strict';

const { AppError } = require('./errors');
const { isBlockedHostname } = require('./network');

const ALIAS_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{1,28})[A-Za-z0-9]$/; // 3-30 chars, no leading/trailing hyphen
const SHORT_CODE_PATTERN = /^[A-Za-z0-9-]{3,30}$/;

/**
 * Names that must never be handed out as short codes because they collide
 * with application routes, static assets or conventional well-known paths.
 */
const RESERVED_ALIASES = new Set([
  'api', 'health', 'healthz', 'livez', 'readyz', 'metrics', 'status', 'dashboard',
  'assets', 'static', 'public', 'favicon', 'robots', 'sitemap', 'manifest', 'index',
  'admin', 'login', 'logout', 'signup', 'register', 'docs', 'about', 'terms',
  'privacy', 'contact', 'help', 'support', 'qr', 'www', 'app', 'null', 'undefined',
  'urlpulse', 'pulse',
]);

const isReserved = (code) => RESERVED_ALIASES.has(String(code).toLowerCase());
const isShortCodeShape = (code) => SHORT_CODE_PATTERN.test(code);

function validateAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
    throw AppError.validation(
      'Custom alias must be 3-30 characters: letters, numbers and hyphens, and cannot start or end with a hyphen',
      { field: 'customAlias' },
    );
  }
  if (isReserved(alias)) {
    throw AppError.validation(`"${alias}" is a reserved word and cannot be used as an alias`, {
      field: 'customAlias',
    });
  }
  return alias;
}

/**
 * Validate and normalise a destination URL.
 * Rejects: non-http(s) schemes, embedded credentials, over-long URLs, internal
 * hosts (unless allowed) and links that would point back at this service.
 */
function validateTargetUrl(input, { maxLength, allowPrivateTargets, selfHosts = [] }) {
  if (typeof input !== 'string' || !input.trim()) {
    throw AppError.validation('originalUrl is required', { field: 'originalUrl' });
  }
  const raw = input.trim();
  if (raw.length > maxLength) {
    throw AppError.validation(`URL is too long (max ${maxLength} characters)`, { field: 'originalUrl' });
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.validation('That does not look like a valid URL. Include http:// or https://', {
      field: 'originalUrl',
    });
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw AppError.validation('Only http:// and https:// URLs can be shortened', { field: 'originalUrl' });
  }
  if (url.username || url.password) {
    throw AppError.validation('URLs containing credentials are not allowed', { field: 'originalUrl' });
  }
  if (!allowPrivateTargets && isBlockedHostname(url.hostname)) {
    throw AppError.validation('Links to localhost or private networks are not allowed', {
      field: 'originalUrl',
    });
  }
  if (selfHosts.some((h) => h && h.toLowerCase() === url.host.toLowerCase())) {
    throw AppError.validation('You cannot shorten a URLPulse link (that would create a redirect loop)', {
      field: 'originalUrl',
    });
  }
  return url.toString();
}

/** Resolve the optional expiry options into a Date (or null). */
function resolveExpiry({ expiresInDays, expiresAt }, now = new Date()) {
  const hasDays = expiresInDays !== undefined && expiresInDays !== null && expiresInDays !== '';
  const hasDate = expiresAt !== undefined && expiresAt !== null && expiresAt !== '';
  if (hasDays && hasDate) {
    throw AppError.validation('Provide either expiresInDays or expiresAt, not both', { field: 'expiresAt' });
  }
  if (hasDays) {
    const days = Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw AppError.validation('expiresInDays must be a whole number between 1 and 365', {
        field: 'expiresInDays',
      });
    }
    return new Date(now.getTime() + days * 86_400_000);
  }
  if (hasDate) {
    const date = new Date(expiresAt);
    if (Number.isNaN(date.getTime())) {
      throw AppError.validation('expiresAt must be a valid ISO-8601 date', { field: 'expiresAt' });
    }
    if (date <= now) throw AppError.validation('expiresAt must be in the future', { field: 'expiresAt' });
    if (date.getTime() - now.getTime() > 366 * 86_400_000) {
      throw AppError.validation('Links can live for at most one year', { field: 'expiresAt' });
    }
    return date;
  }
  return null;
}

module.exports = {
  validateAlias,
  validateTargetUrl,
  resolveExpiry,
  isReserved,
  isShortCodeShape,
  RESERVED_ALIASES,
};
