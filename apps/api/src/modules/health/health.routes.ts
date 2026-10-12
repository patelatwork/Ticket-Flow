import { Router } from 'express';
import type { Redis } from 'ioredis';
import { pool } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';

type Check = 'ok' | 'down';

async function check(fn: () => Promise<unknown>, name: string): Promise<Check> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    logger.warn({ err, dependency: name }, 'readiness check failed');
    return 'down';
  }
}

export function createHealthRouter(redis?: Redis): Router {
  const router = Router();

  /** Liveness: the process is up and serving HTTP. */
  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /**
   * Readiness: load balancers stop routing on 503. Only Postgres gates readiness. With
   * Redis down the API still sells tickets (cache, rate limits and live updates degrade),
   * so Redis is reported but does not fail the check.
   */
  router.get('/ready', async (_req, res) => {
    const [postgres, redisState] = await Promise.all([
      check(() => pool.query('SELECT 1'), 'postgres'),
      redis ? check(() => redis.ping(), 'redis') : Promise.resolve(undefined),
    ]);
    const checks = { postgres, ...(redisState ? { redis: redisState } : {}) };
    res.status(postgres === 'ok' ? 200 : 503).json({ status: postgres === 'ok' ? 'ok' : 'unavailable', checks });
  });

  return router;
}
