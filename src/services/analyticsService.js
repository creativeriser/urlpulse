'use strict';

const { AppError } = require('../lib/errors');
const { isShortCodeShape } = require('../lib/validators');

const DAY_MS = 86_400_000;

const toMap = (rows) => Object.fromEntries(rows.map(({ key, count }) => [key || 'Unknown', count]));
const utcDay = (date) => date.toISOString().slice(0, 10);

class AnalyticsService {
  constructor({ urlRepo, clickRepo, clickBuffer }) {
    this.urlRepo = urlRepo;
    this.clickRepo = clickRepo;
    this.clickBuffer = clickBuffer;
  }

  parseDays(raw) {
    if (raw === undefined || raw === '') return 7;
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw AppError.validation('days must be a whole number between 1 and 90', { field: 'days' });
    }
    return days;
  }

  async get(shortCode, { days = 7, now = new Date() } = {}) {
    if (!isShortCodeShape(shortCode)) throw AppError.notFound();
    const link = await this.urlRepo.findByCode(shortCode);
    if (!link) throw AppError.notFound();

    // Window = the last `days` UTC calendar days, including today.
    const today = new Date(`${utcDay(now)}T00:00:00.000Z`);
    const since = new Date(today.getTime() - (days - 1) * DAY_MS);

    const agg = await this.clickRepo.aggregate(shortCode, { since });

    // Zero-fill so charts always get one point per day.
    const byDate = new Map(agg.timeline.map(({ date, count }) => [date, count]));
    const timeline = Array.from({ length: days }, (_, i) => {
      const date = utcDay(new Date(since.getTime() + i * DAY_MS));
      return { date, clicks: byDate.get(date) || 0 };
    });

    return {
      shortCode,
      originalUrl: link.originalUrl,
      periodDays: days,
      totalClicks: (link.clickCount || 0) + this.clickBuffer.pendingClicks(shortCode),
      clicksInPeriod: agg.total,
      clicksByBrowser: toMap(agg.browsers),
      clicksByOS: toMap(agg.os),
      clicksByDevice: toMap(agg.devices),
      topReferrers: agg.referrers.map(({ key, count }) => ({ referrer: key || 'Direct', count })),
      timeline,
      recentClicks: agg.recent.map((c) => ({
        timestamp: c.timestamp,
        browser: c.browser,
        os: c.os,
        device: c.device,
        referrer: c.referrer || 'Direct',
      })),
      generatedAt: now.toISOString(),
    };
  }
}

module.exports = { AnalyticsService };
