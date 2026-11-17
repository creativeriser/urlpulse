'use strict';

const client = require('prom-client');

const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const NO_METRICS_PATHS = new Set(['/metrics', '/livez']);

/**
 * All Prometheus instrumentation lives here so metric names are defined in
 * exactly one place (and documented in DOCUMENTATION.md > Observability).
 *
 * A fresh Registry is created per app instance, so tests can build many apps
 * in one process without "metric already registered" errors.
 */
function createMetrics(config) {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register });

  // Plain numeric mirrors for /api/stats (no async registry read needed).
  const runtime = { cacheHits: 0, cacheMisses: 0, redirects: 0, linksCreated: 0 };

  const httpRequests = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
  });
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: LATENCY_BUCKETS,
    registers: [register],
  });

  const cacheHits = new client.Counter({
    name: 'urlpulse_redirect_cache_hits_total',
    help: 'Redirect lookups answered from the cache',
    registers: [register],
  });
  const cacheMisses = new client.Counter({
    name: 'urlpulse_redirect_cache_misses_total',
    help: 'Redirect lookups that had to query the database',
    registers: [register],
  });
  const redirects = new client.Counter({
    name: 'urlpulse_redirects_total',
    help: 'Redirect attempts by outcome',
    labelNames: ['outcome'],
    registers: [register],
  });
  const linksCreated = new client.Counter({
    name: 'urlpulse_links_created_total',
    help: 'Short links created',
    labelNames: ['type'],
    registers: [register],
  });
  const linksDeleted = new client.Counter({
    name: 'urlpulse_links_deleted_total',
    help: 'Short links deleted by their owner',
    registers: [register],
  });

  const clicksRecorded = new client.Counter({
    name: 'urlpulse_clicks_recorded_total',
    help: 'Click events persisted to the database',
    registers: [register],
  });
  const clicksDropped = new client.Counter({
    name: 'urlpulse_clicks_dropped_total',
    help: 'Click events dropped because the in-memory queue overflowed',
    registers: [register],
  });
  const clickFlushFailures = new client.Counter({
    name: 'urlpulse_click_flush_failures_total',
    help: 'Failed attempts to flush the click buffer',
    registers: [register],
  });
  const clickQueueSize = new client.Gauge({
    name: 'urlpulse_click_queue_size',
    help: 'Click events waiting in memory to be flushed',
    registers: [register],
  });

  const probes = new client.Counter({
    name: 'urlpulse_probe_total',
    help: 'Uptime probes of monitored destination URLs',
    labelNames: ['result'],
    registers: [register],
  });
  const probeDuration = new client.Histogram({
    name: 'urlpulse_probe_duration_seconds',
    help: 'Latency of uptime probes against destination URLs',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],
    registers: [register],
  });

  new client.Gauge({
    name: 'urlpulse_build_info',
    help: 'Build information (value is always 1)',
    labelNames: ['version', 'commit', 'node_version'],
    registers: [register],
  }).set({ version: config.version, commit: config.commit, node_version: process.version }, 1);

  /**
   * Gauges whose values come from the database / dependencies are evaluated
   * lazily at scrape time. `stats` and `health` are injected after the
   * services exist (see container.js).
   */
  function bindCollectors({ stats, health }) {
    const gauge = (name, help, read, labelNames = []) =>
      new client.Gauge({
        name,
        help,
        labelNames,
        registers: [register],
        async collect() {
          try {
            await read(this);
          } catch {
            /* a failing collector must never break the whole scrape */
          }
        },
      });

    gauge('urlpulse_links', 'Short links stored', async (g) => g.set((await stats.snapshot()).links));
    gauge('urlpulse_monitored_links', 'Links with uptime monitoring enabled', async (g) =>
      g.set((await stats.snapshot()).monitored));
    gauge('urlpulse_monitored_links_down', 'Monitored links failing 2+ consecutive probes', async (g) =>
      g.set((await stats.snapshot()).monitoredDown));
    gauge(
      'urlpulse_dependency_up',
      '1 if a backing service is reachable, else 0',
      async (g) => {
        const h = await health.check();
        g.set({ dependency: 'mongo' }, h.mongo.up ? 1 : 0);
        g.set({ dependency: 'redis' }, h.redis.up ? 1 : 0);
      },
      ['dependency'],
    );
  }

  /** Express middleware: request counter + latency histogram. */
  function httpMiddleware(req, res, next) {
    if (NO_METRICS_PATHS.has(req.path)) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      // Use the route *pattern* (e.g. "/:shortCode") to keep label cardinality bounded.
      const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : res.statusCode === 404 ? 'unmatched' : 'static';
      const labels = { method: req.method, route, status_code: res.statusCode };
      httpRequests.inc(labels);
      httpDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
    });
    return next();
  }

  return {
    register,
    runtime,
    httpMiddleware,
    bindCollectors,
    recordCacheHit() {
      runtime.cacheHits += 1;
      cacheHits.inc();
    },
    recordCacheMiss() {
      runtime.cacheMisses += 1;
      cacheMisses.inc();
    },
    recordRedirect(outcome) {
      if (outcome === 'found') runtime.redirects += 1;
      redirects.inc({ outcome });
    },
    recordLinkCreated(type) {
      runtime.linksCreated += 1;
      linksCreated.inc({ type });
    },
    recordLinkDeleted: () => linksDeleted.inc(),
    recordClicksPersisted: (n) => clicksRecorded.inc(n),
    recordClicksDropped: (n) => clicksDropped.inc(n),
    recordClickFlushFailure: () => clickFlushFailures.inc(),
    setClickQueueSize: (n) => clickQueueSize.set(n),
    recordProbe(ok, seconds) {
      probes.inc({ result: ok ? 'up' : 'down' });
      probeDuration.observe(seconds);
    },
  };
}

module.exports = { createMetrics };
