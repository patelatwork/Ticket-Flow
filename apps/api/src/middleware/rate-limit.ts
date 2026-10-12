import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

const passThrough: RequestHandler = (_req, _res, next) => {
  next();
};

/** Per-user when a valid bearer token is present (fair behind NAT), else per IP. */
function userOrIpKey(req: Request): string {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) {
    try {
      return `u:${verifyAccessToken(header.slice(7)).id}`;
    } catch {
      // Invalid token: fall through to IP; the route itself will reject it.
    }
  }
  return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

export interface RateLimiters {
  /** Login/register/refresh: slows credential stuffing. */
  auth: RequestHandler;
  /** Booking creation and payment start: stops a single client hoarding seats. */
  booking: RequestHandler;
}

/**
 * Counters live in Redis so limits hold across all API instances. If Redis is down the
 * limiter fails OPEN (passOnStoreError): availability over strictness, because the
 * booking path is protected by Postgres anyway. Without Redis (tests) a per-process
 * memory store is used.
 */
export function createRateLimiters(redis?: Redis): RateLimiters {
  if (!env.RATE_LIMIT_ENABLED) return { auth: passThrough, booking: passThrough };

  const make = (prefix: string, overrides: Partial<Options>): RequestHandler =>
    rateLimit({
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      passOnStoreError: true,
      handler: (_req, _res, next) => {
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down'));
      },
      ...(redis
        ? {
            store: new RedisStore({
              prefix: `rl:${prefix}:`,
              sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
            }),
          }
        : {}),
      ...overrides,
    });

  return {
    auth: make('auth', { windowMs: 60_000, limit: 20, keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown') }),
    booking: make('booking', { windowMs: 60_000, limit: 30, keyGenerator: userOrIpKey }),
  };
}
