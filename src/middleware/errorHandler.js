'use strict';

const { AppError } = require('../lib/errors');

/** JSON 404 for unknown /api/* routes (page 404s are handled by the app). */
function apiNotFound(req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `No such endpoint: ${req.method} ${req.originalUrl.split('?')[0]}` },
  });
}

/**
 * Central error handler. Operational errors (AppError) keep their status and
 * message; everything else is logged with context and returned as a generic 500
 * so internals never leak to clients.
 */
function createErrorHandler(logger) {
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    if (err instanceof AppError) {
      return res.status(err.status).json({
        success: false,
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }

    // body-parser / JSON syntax errors
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
      });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        success: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
      });
    }

    logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' },
    });
  };
}

module.exports = { apiNotFound, createErrorHandler };
