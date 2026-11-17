'use strict';

const request = require('supertest');
const { loadConfig } = require('../../src/config');
const { createContainer } = require('../../src/container');
const { createApp } = require('../../src/app');

/**
 * Build a fully wired app on in-memory adapters.
 * `env` overrides configuration, `overrides` injects fakes into the container.
 * Background workers are NOT started: tests drive them explicitly.
 */
async function buildTestApp(env = {}, overrides = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    STORAGE: 'memory',
    CACHE: 'memory',
    BASE_URL: 'http://short.test',
    ...env,
  });
  const container = await createContainer(config, overrides);
  const app = createApp(container);
  return { app, container, config, http: request(app) };
}

module.exports = { buildTestApp };
