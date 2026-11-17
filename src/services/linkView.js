'use strict';

/**
 * Translate a stored URL record into the public API representation.
 * Never exposes manageTokenHash or internal scheduling fields.
 */

function monitorStatus(m) {
  if (!m.enabled) return 'off';
  if (!m.checks) return 'pending';
  if (m.lastOk) return 'up';
  return m.consecutiveFailures >= 2 ? 'down' : 'degraded';
}

function monitorView(m) {
  const checks = m.checks || 0;
  return {
    enabled: Boolean(m.enabled),
    status: monitorStatus(m),
    intervalSeconds: m.intervalSec ?? null,
    lastCheckedAt: m.lastCheckedAt ?? null,
    lastStatusCode: m.lastStatus ?? null,
    lastLatencyMs: m.lastLatencyMs ?? null,
    lastError: m.lastError ?? null,
    consecutiveFailures: m.consecutiveFailures || 0,
    checks,
    uptimePercent: checks ? Math.round((m.successes / checks) * 10_000) / 100 : null,
    history: (m.history || []).map(({ t, ok, ms }) => ({ t, ok, ms })),
  };
}

function toPublicLink(record, { baseUrl, pendingClicks = 0, now = new Date() }) {
  return {
    shortCode: record.shortCode,
    shortUrl: `${baseUrl}/${record.shortCode}`,
    originalUrl: record.originalUrl,
    customAlias: Boolean(record.customAlias),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    expired: Boolean(record.expiresAt && record.expiresAt <= now),
    clickCount: (record.clickCount || 0) + pendingClicks,
    monitor: monitorView(record.monitor),
  };
}

module.exports = { toPublicLink, monitorView, monitorStatus };
