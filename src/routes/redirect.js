'use strict';

const express = require('express');
const { AppError } = require('../lib/errors');
const { isShortCodeShape, isReserved } = require('../lib/validators');
const { hashIp, referrerOrigin } = require('../lib/crypto');
const { parseUserAgent } = require('../lib/userAgent');

/**
 * GET /:shortCode  -> 302 redirect.
 *
 * Anything that is not a plausible short code (has a dot, wrong length, or a
 * reserved word such as "dashboard") falls through to the static site.
 */
function createRedirectRouter({ config, linkService, clickBuffer, metrics }, sendPage) {
  const router = express.Router();

  router.get('/:shortCode', async (req, res, next) => {
    const { shortCode } = req.params;
    if (!isShortCodeShape(shortCode) || isReserved(shortCode)) return next();

    try {
      const { originalUrl } = await linkService.resolve(shortCode);
      metrics.recordRedirect('found');

      // Fire-and-forget: never make the visitor wait for analytics.
      const userAgent = (req.get('user-agent') || '').slice(0, 300);
      clickBuffer.record({
        shortCode,
        timestamp: new Date(),
        ipHash: hashIp(req.ip, config.hashSalt),
        userAgent,
        referrer: referrerOrigin(req.get('referer')),
        ...parseUserAgent(userAgent),
      });

      res.set('Cache-Control', 'no-store');
      return res.redirect(302, originalUrl);
    } catch (err) {
      if (err instanceof AppError && (err.status === 404 || err.status === 410)) {
        metrics.recordRedirect(err.status === 410 ? 'expired' : 'not_found');
        return sendPage(req, res, err);
      }
      return next(err);
    }
  });

  return router;
}

module.exports = { createRedirectRouter };
