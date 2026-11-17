'use strict';

const { Schema } = require('mongoose');

/**
 * Mongoose schemas. They are registered per-connection in ./index.js so the
 * application (and tests) can own a dedicated connection instead of relying
 * on mongoose's global singleton.
 */

const monitorSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    intervalSec: { type: Number, default: null },
    nextCheckAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastStatus: { type: Number, default: null },
    lastLatencyMs: { type: Number, default: null },
    lastOk: { type: Boolean, default: null },
    lastError: { type: String, default: null },
    consecutiveFailures: { type: Number, default: 0 },
    checks: { type: Number, default: 0 },
    successes: { type: Number, default: 0 },
    history: {
      type: [{ _id: false, t: Date, ok: Boolean, ms: Number }],
      default: [],
    },
  },
  { _id: false },
);

const urlSchema = new Schema(
  {
    shortCode: { type: String, required: true, unique: true, index: true },
    originalUrl: { type: String, required: true },
    customAlias: { type: Boolean, default: false },
    clickCount: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
    manageTokenHash: { type: String, required: true },
    monitor: { type: monitorSchema, default: () => ({}) },
  },
  { timestamps: true, versionKey: false, collection: 'urls' },
);

// Partial index: only monitored links participate, so the probe scheduler's
// "what is due?" query stays cheap no matter how many plain links exist.
urlSchema.index(
  { 'monitor.nextCheckAt': 1 },
  { partialFilterExpression: { 'monitor.enabled': true }, name: 'monitor_due' },
);

function buildClickLogSchema(retentionDays) {
  const schema = new Schema(
    {
      shortCode: { type: String, required: true },
      timestamp: { type: Date, required: true, default: Date.now },
      ipHash: { type: String },
      userAgent: { type: String, maxlength: 300 },
      referrer: { type: String, default: '' },
      browser: { type: String },
      os: { type: String },
      device: { type: String },
    },
    { versionKey: false, collection: 'click_logs' },
  );
  schema.index({ shortCode: 1, timestamp: -1 }, { name: 'code_time' });
  // Data-retention policy: MongoDB deletes click logs automatically.
  schema.index({ timestamp: 1 }, { expireAfterSeconds: retentionDays * 86_400, name: 'click_ttl' });
  return schema;
}

module.exports = { urlSchema, buildClickLogSchema };
