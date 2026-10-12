import type { ErrorRequestHandler, RequestHandler } from 'express';
import pg from 'pg';
import { AppError, type ErrorBody } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

/** body-parser and similar middleware attach a status and an `expose` flag. */
function httpErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && expose === true ? status : undefined;
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;

  const clientStatus = httpErrorStatus(err);
  if (clientStatus !== undefined) {
    return new AppError(clientStatus, clientStatus === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', 'Malformed request');
  }

  if (err instanceof pg.DatabaseError) {
    switch (err.code) {
      case '23505': // unique_violation: a race the service did not anticipate
        return AppError.conflict('CONFLICT', 'Resource already exists or is taken');
      case '23503': // foreign_key_violation
        return AppError.conflict('REFERENCE_CONFLICT', 'Referenced resource is missing or still in use');
      case '22P02': // invalid_text_representation
        return AppError.badRequest('BAD_REQUEST', 'Malformed identifier');
      case '40P01': // deadlock_detected: should be impossible given ordered locking; surfaced as retryable
      case '40001': // serialization_failure
        return new AppError(503, 'RETRYABLE_CONFLICT', 'Concurrent update conflict, please retry');
    }
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const appError = toAppError(err);
  const log = req.log as typeof logger | undefined ?? logger;

  if (!appError || appError.status >= 500) {
    log.error({ err }, 'request failed');
  } else {
    log.debug({ code: appError.code }, 'request rejected');
  }

  const body: ErrorBody = appError
    ? appError.toBody()
    : { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };
  if (typeof req.id === 'string') body.error.requestId = req.id;
  if (res.headersSent) return;
  res.status(appError?.status ?? 500).json(body);
};
