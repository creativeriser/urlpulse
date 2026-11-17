'use strict';

const { createLogger } = require('./config/logger');
const { createMetrics } = require('./metrics');
const { MemoryUrlRepository } = require('./adapters/memory/urlRepository');
const { MemoryClickRepository } = require('./adapters/memory/clickRepository');
const { MemoryCache, NullCache } = require('./adapters/cache/memoryCache');
const { RedisCache } = require('./adapters/cache/redisCache');
const { ClickBuffer } = require('./services/clickBuffer');
const { LinkService } = require('./services/linkService');
const { AnalyticsService } = require('./services/analyticsService');
const { MonitorService } = require('./services/monitorService');
const { StatsService } = require('./services/statsService');
const { HealthService } = require('./services/healthService');

/**
 * Composition root: the ONE place where concrete adapters are chosen and wired
 * into services. Everything below this file depends on interfaces (repository /
 * cache contracts), which is what makes the unit + integration tests able to run
 * with in-memory adapters and no infrastructure.
 *
 * `overrides` lets tests inject fakes (e.g. a failing cache, a stub probe).
 */
async function createContainer(config, overrides = {}) {
  const logger = overrides.logger || createLogger(config);
  const metrics = createMetrics(config);

  let urlRepo = overrides.urlRepo;
  let clickRepo = overrides.clickRepo;

  if (!urlRepo || !clickRepo) {
    if (config.storage === 'mongo') {
      // Required lazily so memory mode never loads the mongoose driver.
      const { createMongo } = require('./adapters/mongo');

      const mongo = await createMongo(config.mongoUri, {
        retentionDays: config.clicks.retentionDays,
        logger,
      });

      urlRepo = urlRepo || mongo.urlRepo;
      clickRepo = clickRepo || mongo.clickRepo;
    } else {
      urlRepo = urlRepo || new MemoryUrlRepository();
      clickRepo = clickRepo || new MemoryClickRepository();
    }
  }

  let cache = overrides.cache;

  if (!cache) {
    if (config.cache === 'redis') {
      cache = new RedisCache(config.redisUrl, { logger });
      await cache.connect();
    } else if (config.cache === 'memory') {
      cache = new MemoryCache();
    } else {
      cache = new NullCache();
    }
  }

  const clickBuffer = new ClickBuffer({ clickRepo, urlRepo, config, logger, metrics });
  const linkService = new LinkService({ config, urlRepo, clickRepo, cache, clickBuffer, metrics, logger });
  const analyticsService = new AnalyticsService({ urlRepo, clickRepo, clickBuffer });
  const statsService = new StatsService({ urlRepo, clickBuffer, metrics, config });
  const healthService = new HealthService({ config, urlRepo, cache });
  const monitorService = new MonitorService({ config, urlRepo, logger, metrics, probe: overrides.probe });

  metrics.bindCollectors({ stats: statsService, health: healthService });

  return {
    config,
    logger,
    metrics,
    urlRepo,
    clickRepo,
    cache,
    clickBuffer,
    linkService,
    analyticsService,
    statsService,
    healthService,
    monitorService,

    /** Start background workers (kept out of createContainer so tests stay deterministic). */
    startWorkers() {
      clickBuffer.start();
      monitorService.start();
    },

    /** Ordered, idempotent shutdown: stop workers, flush clicks, close connections. */
    async close() {
      await monitorService.stop();
      await clickBuffer.stop();
      await cache.close?.();
      await urlRepo.close?.();
    },
  };
}

module.exports = { createContainer };
