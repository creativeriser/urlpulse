'use strict';

const pino = require('pino');

function createLogger(config) {
  const options = {
    level: config.logLevel,
    base: { service: config.name, version: config.version },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-manage-token"]',
      ],
      censor: '[redacted]',
    },
  };

  if (config.logPretty) {
    // pino-pretty is a devDependency; it is only loaded in local development.
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service,version' },
    };
  }

  return pino(options);
}

module.exports = { createLogger };
