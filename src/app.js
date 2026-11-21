'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');

const { createRateLimiters } = require('./middleware/rateLimiter');
const { createErrorHandler } = require('./middleware/errorHandler');
const { createApiRouter } = require('./routes/api');
const { createSystemRouter } = require('./routes/system');
const { createRedirectRouter } = require('./routes/redirect');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const QUIET_PATHS = new Set(['/livez', '/health', '/metrics']);

/**
 * Build the Express application from an already-wired container.
 * No network I/O happens here, which keeps it trivial to test with Supertest.
 */
function createApp(container, { publicDir = PUBLIC_DIR } = {}) {
  const { config, logger, metrics } = container;
  const state = (container.state = container.state || { draining: false });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', 'strong');

  // --- correlation id + structured request logging -------------------------
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url) },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // --- security + performance ------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());
  if (config.corsOrigin) {
    app.use('/api', cors({ origin: config.corsOrigin.split(',') }));
  }

  // --- observability -----------------------------------------------------------
  app.use(metrics.httpMiddleware);
  app.use(createSystemRouter({ config, healthService: container.healthService, metrics, state }));

  // --- JSON API ------------------------------------------------------------------
  const limiters = createRateLimiters(config);
  app.use('/api', express.json({ limit: '10kb' }), createApiRouter(container, limiters));

  // --- error / 404 pages (shared by redirect + fallthrough) ---------------------
  const sendPage = (req, res, err) => {
    const status = err.status || 404;
    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(status).json({ success: false, error: { code: err.code, message: err.message } });
    }
    res.set('Cache-Control', 'no-store');
    return res.status(status).sendFile(path.join(publicDir, status === 410 ? 'expired.html' : '404.html'));
  };

  // --- public routes: one limiter for redirects, pages and the 404 page ----------------
  // Mounted after /api (which has its own limiters) and the system routes, so no
  // route is counted twice and health checks / metrics scraping are never limited.
  app.use(limiters.public);

  // --- redirects (hot path) ---------------------------------------------------------
  app.use(createRedirectRouter(container, sendPage));

  // --- static website ------------------------------------------------------------------
  app.use(
    express.static(publicDir, {
      extensions: ['html'],
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}fonts${path.sep}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
        else res.set('Cache-Control', 'public, max-age=3600');
      },
    }),
  );

  app.use((req, res) => sendPage(req, res, { status: 404, code: 'NOT_FOUND', message: 'Page not found' }));
  app.use(createErrorHandler(logger));

  return app;
}

module.exports = { createApp };
