'use strict';

const { assertPublicHost } = require('../lib/network');

const USER_AGENT = 'URLPulse-Monitor/1.0 (+uptime check for a shortened link)';

/** "Up" = the server answered sensibly: 2xx/3xx, or 401/403/429 (reachable but gating bots). */
const isUpStatus = (status) => status < 400 || [401, 403, 429].includes(status);

/**
 * Probe a destination URL once and report { ok, status, latencyMs, error }.
 *
 * Safety:
 *  - the host must resolve to public addresses only (SSRF guard)
 *  - redirects are NOT followed (a 3xx is evidence the server is alive, and
 *    following them could bounce us into an internal network)
 *  - hard timeout, and the response body is never downloaded
 */
async function probeUrl(
  url,
  { timeoutMs = 8000, allowPrivate = false, fetchImpl = globalThis.fetch, assertHost = assertPublicHost } = {},
) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  const attempt = async (method) => {
    const res = await fetchImpl(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, ...(method === 'GET' ? { range: 'bytes=0-0' } : {}) },
    });
    res.body?.cancel().catch(() => {});
    return res.status;
  };

  try {
    if (!allowPrivate) await assertHost(new URL(url).hostname);

    let status = await attempt('HEAD');
    // Some servers reject HEAD; retry with a 1-byte ranged GET.
    if ([403, 405, 501].includes(status)) status = await attempt('GET');

    const ok = isUpStatus(status);
    return { ok, status, latencyMs: elapsed(), error: ok ? null : `HTTP ${status}` };
  } catch (err) {
    const reason =
      err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? 'timeout'
        : String(err?.cause?.code || err?.message || 'request failed').slice(0, 120);
    return { ok: false, status: null, latencyMs: elapsed(), error: reason };
  }
}

module.exports = { probeUrl, isUpStatus };
