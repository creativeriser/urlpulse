'use strict';

/**
 * Operational error that maps cleanly onto an HTTP response.
 * Anything that is NOT an AppError is treated as a bug and becomes a 500.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static validation(message, details) {
    return new AppError(400, 'VALIDATION_ERROR', message, details);
  }
  static unauthorized(message = 'A management token is required') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'The management token is not valid for this link') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Short link not found') {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(message) {
    return new AppError(409, 'ALIAS_TAKEN', message);
  }
  static gone(message = 'This short link has expired') {
    return new AppError(410, 'EXPIRED', message);
  }
}

/** Raised by repositories when a unique constraint (shortCode) is violated. */
class DuplicateKeyError extends Error {
  constructor(key) {
    super(`Duplicate key: ${key}`);
    this.name = 'DuplicateKeyError';
    this.key = key;
  }
}

module.exports = { AppError, DuplicateKeyError };
