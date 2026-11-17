'use strict';

/**
 * Container HEALTHCHECK probe.
 *
 * Written in Node (not wget/curl) so the production image needs no extra
 * binaries - fewer packages means fewer CVEs for Trivy to flag.
 * Exit code 0 = healthy, 1 = unhealthy. DEGRADED (Redis down) still counts as
 * healthy because the service continues to redirect from MongoDB.
 */
const http = require('node:http');

const port = process.env.PORT || 5000;
const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
