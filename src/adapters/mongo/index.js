'use strict';

const mongoose = require('mongoose');
const os = require('node:os');
const { DuplicateKeyError } = require('../../lib/errors');
const { urlSchema, buildClickLogSchema } = require('./models');

const HISTORY_LIMIT = 48;

const MONITOR_DEFAULTS = Object.freeze({
  enabled: false,
  intervalSec: null,
  nextCheckAt: null,
  lastCheckedAt: null,
  lastStatus: null,
  lastLatencyMs: null,
  lastOk: null,
  lastError: null,
  consecutiveFailures: 0,
  checks: 0,
  successes: 0,
  history: [],
});

/** Normalise a lean mongoose document into the repository's plain record shape. */
function toRecord(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { ...rest, monitor: { ...MONITOR_DEFAULTS, ...(doc.monitor || {}) } };
}

const pairs = (rows = []) => rows.map((r) => ({ key: r._id ?? '', count: r.n }));

class MongoUrlRepository {
  constructor(Url) {
    this.Url = Url;
  }

  async create({ shortCode, originalUrl, customAlias = false, expiresAt = null, manageTokenHash, monitor }) {
    const monitorDoc = monitor?.enabled
      ? { enabled: true, intervalSec: monitor.intervalSec, nextCheckAt: new Date() }
      : {};

    try {
      const doc = await this.Url.create({
        shortCode,
        originalUrl,
        customAlias,
        expiresAt,
        manageTokenHash,
        monitor: monitorDoc,
      });

      return toRecord(doc.toObject());
    } catch (err) {
      if (err?.code === 11000) throw new DuplicateKeyError(shortCode);
      throw err;
    }
  }

  async findByCode(shortCode) {
    return toRecord(await this.Url.findOne({ shortCode }).lean());
  }

  async deleteByCode(shortCode) {
    const res = await this.Url.deleteOne({ shortCode });
    return res.deletedCount > 0;
  }

  async incrementClicks(shortCode, amount = 1) {
    await this.Url.updateOne({ shortCode }, { $inc: { clickCount: amount } });
  }

  async setMonitor(shortCode, { enabled, intervalSec }) {
    const set = enabled
      ? { 'monitor.enabled': true, 'monitor.intervalSec': intervalSec, 'monitor.nextCheckAt': new Date() }
      : { 'monitor.enabled': false, 'monitor.nextCheckAt': null };

    const doc = await this.Url.findOneAndUpdate(
      { shortCode },
      { $set: set },
      { returnDocument: 'after' },
    ).lean();

    return toRecord(doc);
  }

  /**
   * Claim up to `limit` due probes. Each claim is a single atomic
   * findOneAndUpdate that pushes nextCheckAt forward (a lease), so several app
   * replicas can run the scheduler without probing the same link twice.
   */
  async claimDueMonitors(limit, now = new Date(), leaseMs = 60_000) {
    const claimed = [];

    for (let i = 0; i < limit; i += 1) {
      const doc = await this.Url.findOneAndUpdate(
        { 'monitor.enabled': true, 'monitor.nextCheckAt': { $lte: now } },
        { $set: { 'monitor.nextCheckAt': new Date(now.getTime() + leaseMs) } },
        { sort: { 'monitor.nextCheckAt': 1 }, returnDocument: 'after' },
      ).lean();

      if (!doc) break;
      claimed.push(toRecord(doc));
    }

    return claimed;
  }

  async recordProbe(shortCode, result, { now = new Date(), intervalSec = 300 } = {}) {
    const update = {
      $set: {
        'monitor.lastCheckedAt': now,
        'monitor.lastStatus': result.status ?? null,
        'monitor.lastLatencyMs': result.latencyMs ?? null,
        'monitor.lastOk': result.ok,
        'monitor.lastError': result.error ?? null,
        'monitor.nextCheckAt': new Date(now.getTime() + intervalSec * 1000),
      },
      $inc: { 'monitor.checks': 1, 'monitor.successes': result.ok ? 1 : 0 },
      $push: {
        'monitor.history': {
          $each: [{ t: now, ok: result.ok, ms: result.latencyMs ?? null }],
          $slice: -HISTORY_LIMIT,
        },
      },
    };

    if (result.ok) update.$set['monitor.consecutiveFailures'] = 0;
    else update.$inc['monitor.consecutiveFailures'] = 1;

    await this.Url.updateOne({ shortCode, 'monitor.enabled': true }, update);
  }

  async counts() {
    const [links, sums, monitored, monitoredDown] = await Promise.all([
      this.Url.estimatedDocumentCount(),
      this.Url.aggregate([{ $group: { _id: null, clicks: { $sum: '$clickCount' } } }]),
      this.Url.countDocuments({ 'monitor.enabled': true }),
      this.Url.countDocuments({
        'monitor.enabled': true,
        'monitor.consecutiveFailures': { $gte: 2 },
      }),
    ]);

    return {
      links,
      clicks: sums[0]?.clicks ?? 0,
      monitored,
      monitoredDown,
    };
  }
}

class MongoClickRepository {
  constructor(ClickLog) {
    this.ClickLog = ClickLog;
  }

  async insertMany(entries) {
    if (!entries.length) return;

    // ordered:false => one bad document cannot block the rest of the batch.
    await this.ClickLog.insertMany(entries, { ordered: false });
  }

  async aggregate(shortCode, { since, recentLimit = 10, referrerLimit = 10 }) {
    const group = (field) => [
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ];

    const [res] = await this.ClickLog.aggregate([
      { $match: { shortCode, timestamp: { $gte: since } } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          browsers: group('browser'),
          os: group('os'),
          devices: group('device'),
          referrers: [...group('referrer'), { $limit: referrerLimit }],
          timeline: [
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: '$timestamp',
                    timezone: 'UTC',
                  },
                },
                n: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
          recent: [
            { $sort: { timestamp: -1 } },
            { $limit: recentLimit },
            {
              $project: {
                _id: 0,
                timestamp: 1,
                browser: 1,
                os: 1,
                device: 1,
                referrer: 1,
              },
            },
          ],
        },
      },
    ]);

    return {
      total: res.total[0]?.n ?? 0,
      browsers: pairs(res.browsers),
      os: pairs(res.os),
      devices: pairs(res.devices),
      referrers: pairs(res.referrers),
      timeline: res.timeline.map((r) => ({ date: r._id, count: r.n })),
      recent: res.recent,
    };
  }

  async deleteByCode(shortCode) {
    await this.ClickLog.deleteMany({ shortCode });
  }
}

async function connectWithRetry(uri, { attempts = 10, delayMs = 2000, logger } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const conn = mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 20,
      runtimeAdapters: {
        os,
      },
    });

    try {
      await conn.asPromise();
      return conn;
    } catch (err) {
      lastError = err;

      logger?.warn(
        { attempt, attempts, err: err.message },
        'mongodb not ready, retrying',
      );

      await conn.close().catch(() => { });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/** Connect to MongoDB and return repositories plus lifecycle helpers. */
async function createMongo(uri, { retentionDays, logger, attempts, delayMs } = {}) {
  const conn = await connectWithRetry(uri, { attempts, delayMs, logger });

  const Url = conn.model('Url', urlSchema);
  const ClickLog = conn.model('ClickLog', buildClickLogSchema(retentionDays));

  // Build indexes up-front so uniqueness is guaranteed before we take traffic.
  await Promise.all([Url.init(), ClickLog.init()]);

  conn.on('disconnected', () => logger?.warn('mongodb disconnected'));
  conn.on('reconnected', () => logger?.info('mongodb reconnected'));

  const urlRepo = new MongoUrlRepository(Url);

  urlRepo.ping = async () => {
    const start = process.hrtime.bigint();
    await conn.db.admin().ping();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  urlRepo.connection = conn;
  urlRepo.isReady = () => conn.readyState === 1;
  urlRepo.close = () => conn.close();

  return {
    urlRepo,
    clickRepo: new MongoClickRepository(ClickLog),
    connection: conn,
  };
}

module.exports = {
  createMongo,
  MongoUrlRepository,
  MongoClickRepository,
};
