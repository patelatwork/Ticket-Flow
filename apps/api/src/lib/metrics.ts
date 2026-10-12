import type { RequestHandler } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { pool } from '../db/pool.js';
import { QUEUE_NAMES } from '../queues/definitions.js';
import { outboxBacklog } from '../queues/outbox.js';
import type { QueueRegistry } from '../queues/queues.js';
import { logger } from './logger.js';

/** One registry per process (API and worker each expose their own /metrics). */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'job_processing_duration_seconds',
  help: 'Time spent processing a job (one attempt)',
  labelNames: ['queue', 'job', 'outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const jobLatency = new Histogram({
  name: 'job_start_latency_seconds',
  help: 'Delay between when a job became due and when a worker started it',
  labelNames: ['queue', 'job'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
  registers: [registry],
});

export const jobsDeadLettered = new Counter({
  name: 'jobs_dead_lettered_total',
  help: 'Jobs moved to the DLQ after exhausting retries',
  labelNames: ['queue', 'job'] as const,
  registers: [registry],
});

/** Route template (e.g. /bookings/:id) rather than the raw URL, to keep label cardinality bounded. */
function routeLabel(req: Parameters<RequestHandler>[0]): string {
  const route: unknown = req.route;
  const path = typeof route === 'object' && route !== null && 'path' in route && typeof route.path === 'string' ? route.path : undefined;
  return path ? `${req.baseUrl}${path}` : 'unmatched';
}

export const httpMetrics: RequestHandler = (req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: routeLabel(req), status: String(res.statusCode) });
  });
  next();
};

let bookingGaugeRegistered = false;
/** Bookings by status, computed at scrape time (one cheap GROUP BY). */
export function registerBookingMetrics(): void {
  if (bookingGaugeRegistered) return;
  bookingGaugeRegistered = true;
  new Gauge({
    name: 'bookings_by_status',
    help: 'Number of bookings in each status',
    labelNames: ['status'] as const,
    registers: [registry],
    async collect() {
      try {
        const { rows } = await pool.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM bookings GROUP BY status`);
        this.reset();
        for (const r of rows) this.set({ status: r.status }, r.n);
      } catch (err) {
        logger.warn({ err }, 'bookings_by_status collection failed');
      }
    },
  });
  new Gauge({
    name: 'outbox_pending',
    help: 'Outbox rows not yet dispatched to the queue',
    registers: [registry],
    async collect() {
      try {
        this.set((await outboxBacklog(pool)).pending);
      } catch (err) {
        logger.warn({ err }, 'outbox_pending collection failed');
      }
    },
  });
}

let queueGaugeRegistered = false;
/** Queue depth per queue and state, read from Redis at scrape time. */
export function registerQueueMetrics(queues: QueueRegistry): void {
  if (queueGaugeRegistered) return;
  queueGaugeRegistered = true;
  new Gauge({
    name: 'queue_jobs',
    help: 'Jobs per queue and state',
    labelNames: ['queue', 'state'] as const,
    registers: [registry],
    async collect() {
      try {
        this.reset();
        await Promise.all(
          QUEUE_NAMES.map(async (name) => {
            const counts = await queues.get(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized');
            for (const [state, n] of Object.entries(counts)) this.set({ queue: name, state }, n);
          }),
        );
      } catch (err) {
        logger.warn({ err }, 'queue_jobs collection failed');
      }
    },
  });
}
