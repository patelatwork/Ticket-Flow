import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Redis } from 'ioredis';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { safeEqual } from './lib/hmac.js';
import { logger } from './lib/logger.js';
import { httpMetrics, registerBookingMetrics, registerQueueMetrics, registry } from './lib/metrics.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createRateLimiters } from './middleware/rate-limit.js';
import { createAdminRouter } from './modules/admin/admin.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { bookingsRouter } from './modules/bookings/bookings.routes.js';
import { DOCS_CSP, docsRouter } from './modules/docs/docs.routes.js';
import { eventsRouter } from './modules/events/events.routes.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import { liveRouter } from './modules/live/live.routes.js';
import { webhooksRouter } from './modules/payments/webhooks.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { ticketsRouter } from './modules/tickets/tickets.routes.js';
import { AppError } from './lib/errors.js';
import type { QueueRegistry } from './queues/queues.js';

const REQUEST_ID_PATTERN = /^[\w.-]{1,128}$/;

/**
 * Infrastructure the app can use when present. Everything degrades without it: tests run
 * with neither (memory rate limits, no cache, in-process seat bus, no Bull Board).
 */
export interface AppDeps {
  redis?: Redis;
  queues?: QueueRegistry;
}

const strictHelmet = helmet();
const docsHelmet = helmet({ contentSecurityPolicy: { directives: DOCS_CSP } });
// Bull Board ships inline scripts/styles.
const boardHelmet = helmet({ contentSecurityPolicy: false });

const securityHeaders: RequestHandler = (req, res, next) => {
  if (req.path.startsWith('/admin/queues')) {
    boardHelmet(req, res, next);
    return;
  }
  if (req.path === '/docs' || req.path.startsWith('/docs/')) {
    docsHelmet(req, res, next);
    return;
  }
  strictHelmet(req, res, next);
};

const metricsAuth: RequestHandler = (req, _res, next) => {
  const token = env.METRICS_TOKEN;
  if (token && !safeEqual(req.headers.authorization ?? '', `Bearer ${token}`)) throw AppError.unauthorized();
  next();
};

export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      // Honour an upstream request id (e.g. from a load balancer) when it is well-formed.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url.startsWith('/health') || req.url === '/metrics' },
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  app.use(httpMetrics);
  app.use(securityHeaders);
  app.use(cookieParser());

  // Before the JSON parser: webhook signatures are verified over the raw bytes.
  app.use('/webhooks', webhooksRouter);
  app.use(express.json({ limit: '100kb' }));

  const limiters = createRateLimiters(deps.redis);
  app.use(['/auth/login', '/auth/register', '/auth/refresh'], limiters.auth);
  app.post('/bookings', limiters.booking);
  app.post('/bookings/:id/pay', limiters.booking);

  registerBookingMetrics();
  if (deps.queues) registerQueueMetrics(deps.queues);
  app.get('/metrics', metricsAuth, async (_req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  });

  app.use('/health', createHealthRouter(deps.redis));
  app.use('/docs', docsRouter);
  app.use('/auth', authRouter);
  app.use('/events', liveRouter);
  app.use('/events', eventsRouter);
  app.use('/bookings', bookingsRouter);
  app.use('/tickets', ticketsRouter);
  app.use('/organizer', reportsRouter);
  app.use('/admin', createAdminRouter(deps.queues));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
