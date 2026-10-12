import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export type RedisRole =
  /** Queue producers, cache, rate limiting: fail fast so callers can degrade gracefully. */
  | 'client'
  /** BullMQ workers: blocking commands, must retry forever (BullMQ requirement). */
  | 'worker'
  /** Pub/sub subscriber: a connection in subscriber mode can't run other commands. */
  | 'subscriber';

/**
 * The one place Redis connections are created. Each role gets its own connection
 * because their requirements conflict (blocking vs fail-fast vs subscriber mode).
 */
export function createRedis(role: RedisRole, url: string = env.REDIS_URL): Redis {
  const options: RedisOptions = {
    connectionName: `ticketflow-${role}`,
    // Exponential reconnect, capped at 5s.
    retryStrategy: (times) => Math.min(100 * 2 ** times, 5_000),
    ...(role === 'client'
      ? { maxRetriesPerRequest: 2, enableOfflineQueue: false, connectTimeout: 5_000 }
      : { maxRetriesPerRequest: null }),
  };
  const redis = new Redis(url, options);
  let lastError = '';
  redis.on('error', (err: Error) => {
    // ioredis emits on every failed reconnect; log each distinct error once.
    if (err.message !== lastError) logger.warn({ err, role }, 'redis connection error');
    lastError = err.message;
  });
  redis.on('ready', () => {
    if (lastError) logger.info({ role }, 'redis connection restored');
    lastError = '';
  });
  return redis;
}
