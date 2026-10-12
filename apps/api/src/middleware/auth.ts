import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken, type AuthUser, type Role } from '../modules/auth/tokens.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw AppError.unauthorized('Malformed Authorization header', 'INVALID_TOKEN');
  return token;
}

/** Requires a valid access token. */
export const authenticate: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const token = bearerToken(req);
  if (!token) throw AppError.unauthorized();
  req.user = verifyAccessToken(token);
  next();
};

/** Attaches the user when a valid token is present; anonymous requests pass through. */
export const optionalAuthenticate: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const token = bearerToken(req);
  if (token) req.user = verifyAccessToken(token);
  next();
};

/** Must run after `authenticate`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = currentUser(req);
    if (!roles.includes(user.role)) throw AppError.forbidden();
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}
