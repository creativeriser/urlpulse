'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { apiNotFound } = require('../middleware/errorHandler');

/** Absolute base URL used to build short links (configured, or derived from the request). */
function baseUrlFor(req, config) {
  return config.baseUrl || `${req.protocol}://${req.get('host')}`;
}

/** Hosts that must never be shortened (this service itself => redirect loops). */
function selfHostsFor(req, config) {
  const hosts = [req.get('host')];
  if (config.baseUrl) {
    try {
      hosts.push(new URL(config.baseUrl).host);
    } catch {
      /* ignore malformed BASE_URL; config validation happens at deploy time */
    }
  }
  return hosts;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createApiRouter({ config, linkService, analyticsService, statsService }, limiters) {
  const router = express.Router();
  const body = (req) => (isPlainObject(req.body) ? req.body : {});

  // POST /api/url/shorten
  router.post('/url/shorten', limiters.write, async (req, res) => {
    const baseUrl = baseUrlFor(req, config);
    const { link, manageToken } = await linkService.create(body(req), {
      baseUrl,
      selfHosts: selfHostsFor(req, config),
    });
    res
      .status(201)
      .location(`${baseUrl}/api/url/${link.shortCode}`)
      .json({
        success: true,
        shortUrl: link.shortUrl,
        shortCode: link.shortCode,
        originalUrl: link.originalUrl,
        expiresAt: link.expiresAt,
        qrUrl: `${baseUrl}/api/url/${link.shortCode}/qr`,
        // Shown ONCE. Whoever holds this token can delete / reconfigure the link.
        manageToken,
        link,
      });
  });

  // GET /api/availability/:alias  (live alias check)
  router.get('/availability/:alias', limiters.read, async (req, res) => {
    res.json({ success: true, ...(await linkService.checkAlias(req.params.alias)) });
  });

  // GET /api/url/:shortCode/qr
  router.get('/url/:shortCode/qr', limiters.read, async (req, res) => {
    const baseUrl = baseUrlFor(req, config);
    const link = await linkService.get(req.params.shortCode, { baseUrl });
    const format = req.query.format === 'png' ? 'png' : 'svg';
    const size = Math.min(1024, Math.max(128, Number.parseInt(req.query.size, 10) || 320));

    res.set('Cache-Control', 'public, max-age=86400');
    if (req.query.download === '1') {
      res.set('Content-Disposition', `attachment; filename="urlpulse-${link.shortCode}.${format}"`);
    }
    if (format === 'png') {
      const png = await QRCode.toBuffer(link.shortUrl, { type: 'png', width: size, margin: 2, errorCorrectionLevel: 'M' });
      res.type('image/png').send(png);
    } else {
      const svg = await QRCode.toString(link.shortUrl, { type: 'svg', width: size, margin: 2, errorCorrectionLevel: 'M' });
      res.type('image/svg+xml').send(svg);
    }
  });

  // GET /api/url/:shortCode
  router.get('/url/:shortCode', limiters.read, async (req, res) => {
    const link = await linkService.get(req.params.shortCode, { baseUrl: baseUrlFor(req, config) });
    res.json({ success: true, ...link });
  });

  // DELETE /api/url/:shortCode   (X-Manage-Token)
  router.delete('/url/:shortCode', limiters.write, async (req, res) => {
    await linkService.remove(req.params.shortCode, req.get('x-manage-token'));
    res.status(204).end();
  });

  // PATCH /api/url/:shortCode/monitor   (X-Manage-Token)
  router.patch('/url/:shortCode/monitor', limiters.write, async (req, res) => {
    const link = await linkService.setMonitor(
      req.params.shortCode,
      req.get('x-manage-token'),
      body(req),
      { baseUrl: baseUrlFor(req, config) },
    );
    res.json({ success: true, ...link });
  });

  // GET /api/analytics/:shortCode?days=7
  router.get('/analytics/:shortCode', limiters.read, async (req, res) => {
    const days = analyticsService.parseDays(req.query.days);
    res.json({ success: true, ...(await analyticsService.get(req.params.shortCode, { days })) });
  });

  // GET /api/stats
  router.get('/stats', limiters.read, async (req, res) => {
    res.set('Cache-Control', 'public, max-age=5');
    res.json({ success: true, ...(await statsService.publicStats()) });
  });

  router.use(apiNotFound);
  return router;
}

module.exports = { createApiRouter, baseUrlFor };
