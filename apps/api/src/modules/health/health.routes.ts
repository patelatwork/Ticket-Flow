import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';

export const healthRouter = Router();

/** Liveness: the process is up and serving HTTP. */
healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Readiness: dependencies are reachable; load balancers should stop routing on 503. */
healthRouter.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', checks: { postgres: 'ok' } });
  } catch (err) {
    logger.warn({ err }, 'readiness check failed');
    res.status(503).json({ status: 'unavailable', checks: { postgres: 'down' } });
  }
});
