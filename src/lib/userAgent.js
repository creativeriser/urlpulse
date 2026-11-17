'use strict';

/**
 * Tiny, dependency-free User-Agent classifier. It only needs to be good
 * enough for dashboard-level analytics (browser / OS / device family).
 */

const BOT_PATTERN =
  /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|monitor|uptime|python-requests|go-http-client|okhttp|libwww|java\//i;
const CLI_PATTERN = /^(curl|wget|httpie)\b/i;

function parseUserAgent(ua = '') {
  const s = String(ua);
  if (!s) return { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };

  if (CLI_PATTERN.test(s)) return { browser: 'CLI', os: 'Unknown', device: 'Bot' };
  if (BOT_PATTERN.test(s)) return { browser: 'Bot', os: detectOs(s), device: 'Bot' };

  return { browser: detectBrowser(s), os: detectOs(s), device: detectDevice(s) };
}

function detectBrowser(s) {
  if (/Edg(e|A|iOS)?\//.test(s)) return 'Edge';
  if (/OPR\/|Opera/.test(s)) return 'Opera';
  if (/SamsungBrowser\//.test(s)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS\//.test(s)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(s)) return 'Chrome';
  if (/Safari\//.test(s) && /Version\//.test(s)) return 'Safari';
  if (/MSIE |Trident\//.test(s)) return 'Internet Explorer';
  return 'Other';
}

function detectOs(s) {
  if (/Windows/i.test(s)) return 'Windows';
  if (/Android/i.test(s)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(s)) return 'iOS';
  if (/Mac OS X|Macintosh/i.test(s)) return 'macOS';
  if (/CrOS/.test(s)) return 'ChromeOS';
  if (/Linux|X11/i.test(s)) return 'Linux';
  return 'Other';
}

function detectDevice(s) {
  if (/iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) return 'Tablet';
  if (/Mobi|iPhone|iPod|Android/i.test(s)) return 'Mobile';
  return 'Desktop';
}

module.exports = { parseUserAgent };
