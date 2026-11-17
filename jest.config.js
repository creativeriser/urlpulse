'use strict';

/** Unit + integration tests. These need NO external services (in-memory adapters). */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.js', '<rootDir>/tests/integration/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  clearMocks: true,
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/server.js', // process bootstrap: exercised by the e2e/smoke tests
    '!src/adapters/mongo/**', // needs a real MongoDB: covered by tests/e2e
    '!src/adapters/cache/redisCache.js', // needs a real Redis: covered by tests/e2e
  ],
  coverageReporters: ['text-summary', 'lcov'],
  coverageThreshold: {
    global: { statements: 85, branches: 75, functions: 85, lines: 85 },
  },
};
