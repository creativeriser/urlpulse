'use strict';

/**
 * End-to-end tests against REAL MongoDB and Redis.
 *   - In CI they run against GitHub Actions service containers.
 *   - Locally: `docker compose up -d mongo redis` (the dev override publishes both on 127.0.0.1), then
 *       MONGO_URI='mongodb://<user>:<password>@127.0.0.1:27017/urlpulse_e2e?authSource=admin' \
 *       REDIS_URL='redis://:<password>@127.0.0.1:6379' npm run test:e2e
 *     (credentials are in .env; plain `mongodb://localhost:27017/...` works against an unauthenticated mongod)
 * The suites skip themselves when MONGO_URI / REDIS_URL are not set.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/e2e/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  testTimeout: 30_000,
};
