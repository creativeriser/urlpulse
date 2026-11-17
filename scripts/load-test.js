#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency load test for the redirect hot path.
 *
 *   node scripts/load-test.js [--url http://127.0.0.1:5000] [--duration 10] [--concurrency 50]
 *
 * It creates one short link, then hammers GET /<code> with N concurrent keep-alive
 * connections for the given number of seconds, and reports throughput, latency
 * percentiles and the status-code mix (302 = success).
 *
 * Read the numbers honestly: the load generator, the app and (locally) the database all
 * share one machine, so results are a relative measure (before/after a change), not a
 * capacity promise. Run it against a staging stack for numbers that mean something.
 * Only test servers you own: this is a stress tool.
 */

const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');

function parseArgs(argv) {
  const args = { url: 'http://127.0.0.1:5000', duration: 10, concurrency: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in args) || value === undefined) {
      console.error(`Unknown or incomplete option: ${argv[i]}`);
      console.error('Usage: node scripts/load-test.js [--url URL] [--duration SECONDS] [--concurrency N]');
      process.exit(2);
    }
    args[key] = key === 'url' ? value.replace(/\/+$/, '') : Number(value);
    i += 1;
  }
  if (!(args.duration > 0) || !(args.concurrency > 0)) {
    console.error('--duration and --concurrency must be positive numbers');
    process.exit(2);
  }
  return args;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function main() {
  const { url, duration, concurrency } = parseArgs(process.argv.slice(2));
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: concurrency });

  const request = (method, path, body, extraHeaders = {}) =>
    new Promise((resolve, reject) => {
      const req = lib.request(
        {
          agent,
          method,
          hostname: target.hostname,
          port: target.port,
          path,
          headers: {
            ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
            ...extraHeaders,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });

  const created = await request('POST', '/api/url/shorten', JSON.stringify({ originalUrl: 'https://example.com/load-test' }));
  if (created.status !== 201) {
    console.error(`Could not create a test link (HTTP ${created.status}): ${created.body}`);
    process.exit(1);
  }
  const { shortCode, manageToken } = JSON.parse(created.body);
  const path = `/${shortCode}`;

  console.log(`Target      ${url}${path}`);
  console.log(`Load        ${concurrency} connections for ${duration}s\n`);

  const latencies = [];
  const statuses = new Map();
  let errors = 0;
  const deadline = performance.now() + duration * 1000;

  const worker = async () => {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      try {
        const { status } = await request('GET', path);
        latencies.push(performance.now() - t0);
        statuses.set(status, (statuses.get(status) || 0) + 1);
      } catch {
        errors += 1;
      }
    }
  };

  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;

  // Clean up the test link (best effort)
  const cleanup = await request('DELETE', `/api/url/${shortCode}`, undefined, { 'X-Manage-Token': manageToken }).catch(() => null);
  agent.destroy();

  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const fmt = (n) => `${n.toFixed(2)} ms`;

  console.log(`Requests    ${total} completed, ${errors} failed`);
  console.log(`Throughput  ${(total / elapsed).toFixed(0)} req/s`);
  if (total) {
    console.log(`Latency     p50 ${fmt(percentile(latencies, 50))}   p95 ${fmt(percentile(latencies, 95))}   p99 ${fmt(percentile(latencies, 99))}   max ${fmt(latencies[total - 1])}`);
  }
  console.log(`Status      ${[...statuses].map(([s, n]) => `${s} x${n}`).join(', ') || 'none'}`);
  if (!cleanup || ![200, 204].includes(cleanup.status)) {
    console.log(`\nCould not delete the test link /${shortCode}. Remove it with the X-Manage-Token header: ${manageToken}`);
  }

  const bad = [...statuses].filter(([s]) => s !== 302).reduce((n, [, c]) => n + c, 0);
  if (errors > 0 || bad > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
