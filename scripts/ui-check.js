#!/usr/bin/env node
'use strict';
/* global document, window, location */

/**
 * Browser smoke check for the website (optional; not part of `npm test`).
 *
 * Drives the real pages in headless Chromium at phone width, in light and dark,
 * and checks the behaviour documented in docs/design/WEBSITE_SPEC.md:
 * no sideways scroll, the create flow, the dashboard, all five status headlines,
 * and that nothing fails except the requests this script provokes on purpose.
 *
 *   npm start                                   # in one terminal (memory mode is fine)
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/ui-check.js [base-url]         # default http://localhost:5000
 *
 * Env: SHOT_DIR=<dir> also saves a full-page screenshot of each page.
 * Exit code 0 = every check passed.
 */

const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
const SHOT_DIR = process.env.SHOT_DIR;
const results = [];
const check = (name, pass, detail = '') => results.push({ pass: Boolean(pass), line: `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}` });

const HEALTH = (status, { mongoUp = true, redisUp = true } = {}) => ({
  status,
  mongo: 'connected',
  redis: 'connected',
  checks: { mongo: { up: mongoUp, latencyMs: 3 }, redis: { up: redisUp, latencyMs: 1 } },
  version: '0.0.0',
  commit: 'test',
  uptimeSeconds: 1,
  timestamp: new Date().toISOString(),
});

const STATUS_CASES = [
  { name: 'UP', code: 200, body: HEALTH('UP'), headline: 'All systems operational' },
  { name: 'DEGRADED', code: 200, body: HEALTH('DEGRADED', { redisUp: false }), headline: 'Running with reduced performance' },
  { name: 'DOWN', code: 503, body: HEALTH('DOWN', { mongoUp: false }), headline: 'Service outage' },
  { name: 'DRAINING', code: 503, body: HEALTH('DRAINING'), headline: 'Restarting' },
  { name: 'unreachable', abort: true, headline: 'Cannot reach the server' },
];

async function runTheme(browser, scheme) {
  const tag = `[${scheme}]`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
  const page = await ctx.newPage();
  const jsErrors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`);
  });

  const noSideways = async (label) => {
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    check(`${tag} ${label}: no horizontal scroll`, sw <= cw, `${sw} vs ${cw}`);
  };
  const shot = async (name) => {
    if (SHOT_DIR) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(SHOT_DIR, `${name}-${scheme}.png`), fullPage: true });
    }
  };

  // --- Home --------------------------------------------------------------------------
  await page.goto(`${BASE}/`);
  await noSideways('home');
  await page.click('#submit-btn');
  check(`${tag} home: empty submit shows the error`, (await page.textContent('#url-error')).includes('Paste the URL'));
  check(`${tag} home: empty submit focuses the URL field`, await page.evaluate(() => document.activeElement.id === 'url'));

  await page.fill('#url', 'example.com/some/long/path');
  await page.fill('#alias', 'dashboard');
  await page.click('#submit-btn');
  await page.waitForFunction(() => document.querySelector('#url-error').textContent.length > 0);
  check(`${tag} home: reserved alias is rejected and marked invalid`, (await page.getAttribute('#alias', 'aria-invalid')) === 'true');

  await page.fill('#alias', '');
  await page.click('#watch-field .switch');
  check(`${tag} home: uptime switch turns on`, await page.isChecked('#watch'));
  await page.click('#submit-btn');
  await page.waitForSelector('#result:not([hidden])');
  const shortUrl = await page.textContent('#result-url');
  check(`${tag} home: a short link is shown`, shortUrl.startsWith(BASE), shortUrl);
  check(`${tag} home: the result has focus`, await page.evaluate(() => document.activeElement.id === 'result'));
  check(`${tag} home: the QR code loads`, await page.evaluate(() => {
    const img = document.querySelector('#result-qr');
    return img.complete && img.naturalWidth > 0;
  }));
  await noSideways('home with result');
  await shot('home');

  const code = shortUrl.split('/').pop();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('urlpulse.links.v1') || '[]'));
  check(`${tag} home: the link and its management key are saved in the browser`, stored[0]?.shortCode === code && Boolean(stored[0]?.manageToken));

  const redirect = await ctx.request.get(shortUrl, { maxRedirects: 0 });
  check(`${tag} redirect: 302 with no-store`, redirect.status() === 302 && redirect.headers()['cache-control'] === 'no-store', String(redirect.status()));

  // --- Dashboard ----------------------------------------------------------------------
  await page.goto(`${BASE}/dashboard`);
  await page.waitForSelector('#detail-body:not([hidden])');
  await noSideways('dashboard');
  check(`${tag} dashboard: the newest link is selected`, (await page.evaluate(() => location.hash.slice(1))) === code);
  await page.waitForSelector('.segmented button');
  await page.focus('.segmented button:nth-child(2)');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  check(`${tag} dashboard: changing the range keeps keyboard focus`, /30/.test(await page.evaluate(() => document.activeElement.textContent)));
  const disclosures = await page.$$('details.table-view > summary');
  check(`${tag} dashboard: table views are available`, disclosures.length >= 1);
  if (disclosures.length) await disclosures[0].click();
  await noSideways('dashboard with a table open');
  await shot('dashboard');

  await page.fill('#lookup', '!!');
  await page.click('#lookup-form button[type=submit]');
  check(`${tag} dashboard: an invalid lookup explains the rule`, (await page.textContent('#lookup-error')).includes('3 to 30'));
  await page.fill('#lookup', 'nope-nope');
  await page.click('#lookup-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#detail-body')?.textContent.includes('No link with the code'));
  check(`${tag} dashboard: an unknown code shows the not-found state`, true);

  // read-only mode: same link without the stored key
  await page.evaluate(() => localStorage.removeItem('urlpulse.links.v1'));
  await page.goto(`${BASE}/dashboard#${code}`);
  await page.waitForSelector('.detail-head');
  check(`${tag} dashboard: without the key there is no Delete button`, (await page.locator('#detail-body button:has-text("Delete")').count()) === 0);
  check(`${tag} dashboard: without the key a notice explains why`, (await page.textContent('.notice')).includes('public analytics'));

  // --- Status: every headline state ------------------------------------------------------
  for (const c of STATUS_CASES) {
    await page.unroute('**/health').catch(() => {});
    await page.route('**/health', (route) => (c.abort ? route.abort() : route.fulfill({ status: c.code, contentType: 'application/json', body: JSON.stringify(c.body) })));
    await page.goto(`${BASE}/status`);
    try {
      await page.waitForFunction((text) => document.querySelector('#state-text')?.textContent.includes(text), c.headline, { timeout: 5000 });
      check(`${tag} status: ${c.name} headline`, true, c.headline);
    } catch {
      check(`${tag} status: ${c.name} headline`, false, `expected "${c.headline}"`);
    }
    if (c.name === 'UP') {
      await noSideways('status');
      await shot('status');
    }
  }
  await page.unroute('**/health').catch(() => {});

  // --- Error page -----------------------------------------------------------------------
  const missing = await page.goto(`${BASE}/zzzzzz-not-a-link`);
  check(`${tag} 404: status code and page`, missing.status() === 404 && (await page.textContent('h1')).includes('Nothing here'));
  await noSideways('404');

  check(`${tag} no JavaScript errors`, jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));
  // Exactly the requests this script provokes: reserved alias (400), unknown code (404 x2), missing page (404)
  const unexpected = failedRequests.filter((r) => !/POST \/api\/url\/shorten$|nope-nope|zzzzzz-not-a-link/.test(r) && !/^503 GET \/health/.test(r));
  check(`${tag} no unexpected failed requests`, unexpected.length === 0, unexpected.join(', '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await runTheme(browser, 'light');
    await runTheme(browser, 'dark');
  } finally {
    await browser.close();
  }
  console.log(results.map((r) => r.line).join('\n'));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
