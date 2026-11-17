'use strict';

const { loadConfig } = require('./config');
const { createContainer } = require('./container');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const container = await createContainer(config);
  const { logger } = container;
  const app = createApp(container);

  const server = app.listen(config.port, config.host);
  // Must exceed typical proxy/load-balancer idle timeouts (nginx 60s, AWS ALB 60s)
  // or the proxy can reuse a connection that Node has just closed (502s).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  container.startWorkers();
  logger.info(
    {
      port: config.port,
      env: config.nodeEnv,
      storage: config.storage,
      cache: config.cache,
      monitor: config.monitor.enabled,
      commit: config.commit,
    },
    `URLPulse ${config.version} listening on :${config.port}`,
  );
  if (config.storage === 'memory') {
    logger.warn('running with in-memory storage: data is lost on restart (set MONGO_URI for persistence)');
  }

  // --- graceful shutdown ---------------------------------------------------------
  let shuttingDown = false;
  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    container.state.draining = true; // /health now returns 503 so load balancers stop routing to us
    logger.info({ signal }, 'shutdown requested: draining connections');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();

    server.close(async (err) => {
      if (err) logger.error({ err }, 'error while closing HTTP server');
      try {
        await container.close(); // flush buffered clicks, close Redis + MongoDB pools
        logger.info('shutdown complete');
        process.exit(exitCode);
      } catch (closeErr) {
        logger.error({ err: closeErr }, 'error during shutdown');
        process.exit(1);
      }
    });
    server.closeIdleConnections?.();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandled promise rejection');
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    shutdown('uncaughtException', 1);
  });
}

main().catch((err) => {
  // Logger may not exist yet (config errors), so use stderr directly.
  console.error('Fatal start-up error:', err.message);
  process.exit(1);
});
