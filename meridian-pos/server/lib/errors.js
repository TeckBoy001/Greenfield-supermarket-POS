'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const E = {
  badRequest: (msg, details) => new AppError(400, 'bad_request', msg, details),
  validation: (msg, details) => new AppError(422, 'validation_error', msg, details),
  unauthorized: (msg = 'Please sign in') => new AppError(401, 'unauthorized', msg),
  forbidden: (msg = 'You do not have permission for this action', details) => new AppError(403, 'forbidden', msg, details),
  overrideRequired: (permission, msg) => new AppError(403, 'override_required', msg || 'Supervisor approval required', { permission }),
  notFound: (what = 'Record') => new AppError(404, 'not_found', `${what} not found`),
  conflict: (msg, details) => new AppError(409, 'conflict', msg, details),
  offline: (msg) => new AppError(503, 'offline', msg || 'This action needs a network connection'),
  provider: (msg, details) => new AppError(502, 'provider_error', msg, details),
};

module.exports = { AppError, E };
