import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { cookieSecure, env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser, requireRole } from '../../middleware/auth.js';
import type { QueueRegistry } from '../../queues/queues.js';
import { verifyAccessToken } from '../auth/tokens.js';
import * as dlqService from './dlq.service.js';

export const ADMIN_COOKIE = 'tf_admin';
const BOARD_PATH = '/admin/queues';

function cookieToken(req: Request): string | undefined {
  const cookies: unknown = req.cookies;
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  const value: unknown = (cookies as Record<string, unknown>)[ADMIN_COOKIE];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Bull Board is a browser UI whose own XHRs can't carry our bearer header, so admins
 * first call POST /admin/session (bearer) which sets a short-lived httpOnly cookie
 * scoped to /admin. Either the header or that cookie must carry an admin token.
 */
const requireAdminBrowserOrBearer: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7) : cookieToken(req);
  if (!token) throw AppError.unauthorized();
  const user = verifyAccessToken(token);
  if (user.role !== 'admin') throw AppError.forbidden();
  req.user = user;
  next();
};

const DlqParamsSchema = z.object({ id: z.string().min(1).max(300) });
const DlqQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

export function createAdminRouter(queues: QueueRegistry | undefined): Router {
  const router = Router();

  router.post('/session', authenticate, requireRole('admin'), (req, res) => {
    const header = req.headers.authorization ?? '';
    res.cookie(ADMIN_COOKIE, header.slice(7), {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'strict',
      path: '/admin',
      maxAge: env.JWT_ACCESS_TTL_SECONDS * 1000,
    });
    res.json({ user: currentUser(req), board: BOARD_PATH });
  });

  const needQueues = (): QueueRegistry => {
    if (!queues) throw new AppError(503, 'QUEUES_UNAVAILABLE', 'Queue backend is not configured');
    return queues;
  };

  router.get('/dlq', requireAdminBrowserOrBearer, async (req, res) => {
    const { limit } = parse(DlqQuerySchema, req.query, 'query');
    res.json({ jobs: await dlqService.listDeadLetters(needQueues(), limit) });
  });

  router.post('/dlq/:id/retry', requireAdminBrowserOrBearer, async (req, res) => {
    const { id } = parse(DlqParamsSchema, req.params, 'path');
    res.json(await dlqService.retryDeadLetter(needQueues(), id));
  });

  if (queues) {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath(BOARD_PATH);
    createBullBoard({ queues: queues.all().map((q) => new BullMQAdapter(q)), serverAdapter });
    router.use('/queues', requireAdminBrowserOrBearer, serverAdapter.getRouter() as RequestHandler);
  }

  return router;
}
