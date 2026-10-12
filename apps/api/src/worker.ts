import { createServer } from 'node:http';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { env } from './config/env.js';
import { closePool, pool } from './db/pool.js';
import { logger as rootLogger } from './lib/logger.js';
import { jobDuration, jobLatency, jobsDeadLettered, registerBookingMetrics, registerQueueMetrics, registry } from './lib/metrics.js';
import { moveToDeadLetter } from './modules/admin/dlq.service.js';
import { mockConfigFromEnv } from './modules/payments/providers/registry.js';
import { createRedis } from './queues/connection.js';
import { JOBS, QUEUE_NAMES, WORKER_CONFIG, type QueueName } from './queues/definitions.js';
import { createRuntime, ensureBucketInBackground } from './runtime.js';
import { startOutboxRelay } from './workers/outbox-relay.js';
import { createProcessor } from './workers/processors.js';

/**
 * The worker process: BullMQ consumers for every queue, the outbox relay, and the
 * repeatable-job schedulers. Separate from the API so each scales independently.
 */
const logger = rootLogger.child({ process: 'worker' });
const runtime = createRuntime({ subscriber: false });
const { queues } = runtime;
ensureBucketInBackground();

const mockConfig = mockConfigFromEnv();
const deps = {
  queues,
  mockDelivery: {
    store: runtime.mockStore,
    config: mockConfig,
    post: async (body: string, headers: Record<string, string>) => {
      const res = await fetch(`${env.API_BASE_URL}/webhooks/payments/mock`, {
        method: 'POST',
        body,
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      return res.status;
    },
  },
};

function isFinalFailure(job: Job, err: Error): boolean {
  return err instanceof UnrecoverableError || err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

const workers = QUEUE_NAMES.filter((name): name is Exclude<QueueName, 'dlq'> => name !== 'dlq').map((name) => {
  const config = WORKER_CONFIG[name];
  const worker = new Worker(name, createProcessor(name, deps), {
    connection: createRedis('worker'),
    prefix: env.QUEUE_PREFIX,
    concurrency: config.concurrency,
    ...(config.limiter ? { limiter: config.limiter } : {}),
    // A job whose worker died is re-delivered after the lock expires (stalled job check).
    lockDuration: 60_000,
    maxStalledCount: 2,
  });

  worker.on('active', (job) => {
    const dueAt = job.timestamp + (job.opts.delay ?? 0);
    jobLatency.observe({ queue: name, job: job.name }, Math.max(0, Date.now() - dueAt) / 1000);
  });
  worker.on('completed', (job) => {
    if (job.processedOn && job.finishedOn) {
      jobDuration.observe({ queue: name, job: job.name, outcome: 'completed' }, (job.finishedOn - job.processedOn) / 1000);
    }
  });
  worker.on('failed', (job, err) => {
    if (!job) return;
    if (job.processedOn) jobDuration.observe({ queue: name, job: job.name, outcome: 'failed' }, (Date.now() - job.processedOn) / 1000);
    const final = isFinalFailure(job, err);
    logger[final ? 'error' : 'warn']({ err, queue: name, job: job.name, jobId: job.id, attempt: job.attemptsMade }, final ? 'job failed permanently' : 'job failed; will retry');
    if (!final) return;
    jobsDeadLettered.inc({ queue: name, job: job.name });
    moveToDeadLetter(queues, job, name, err.message).catch((dlqErr: unknown) => {
      logger.error({ err: dlqErr, jobId: job.id }, 'could not move job to DLQ');
    });
  });
  worker.on('error', (err) => {
    logger.error({ err, queue: name }, 'worker error');
  });
  return worker;
});

const relay = startOutboxRelay(pool, {
  enqueue: async ({ name, data, jobId, delayMs }) => {
    await queues.get(JOBS[name].queue).add(name, data, { jobId, delay: delayMs });
  },
});

async function upsertSchedulers(): Promise<void> {
  await queues
    .get('payments')
    .upsertJobScheduler('payment-reconciliation', { every: 5 * 60_000 }, { name: 'payment-reconciliation', data: {} });
  // 00:30 UTC: yesterday's numbers are final by then.
  await queues
    .get('reports')
    .upsertJobScheduler('daily-sales-report', { pattern: '30 0 * * *', tz: 'UTC' }, { name: 'daily-sales-report-fanout', data: {} });
}
upsertSchedulers()
  .then(() => {
    logger.info('job schedulers registered');
  })
  .catch((err: unknown) => {
    logger.error({ err }, 'failed to register job schedulers');
  });

registerBookingMetrics();
registerQueueMetrics(queues);
const metricsServer = createServer((req, res) => {
  if (req.url === '/metrics') {
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType }).end(body);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'metrics collection failed');
        res.writeHead(500).end();
      });
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', workers: workers.length }));
    return;
  }
  res.writeHead(404).end();
});
metricsServer.listen(env.WORKER_METRICS_PORT, () => {
  logger.info({ queues: workers.map((w) => w.name), metricsPort: env.WORKER_METRICS_PORT, mock: mockConfig }, 'worker started');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down: finishing active jobs');
  const forceExit = setTimeout(() => {
    logger.error('worker shutdown timed out; forcing exit (unfinished jobs will be re-delivered as stalled)');
    process.exit(1);
  }, 30_000);
  forceExit.unref();

  // Stop taking new work first, then let in-flight jobs finish (Worker.close waits for them).
  await relay.stop();
  await Promise.allSettled(workers.map((w) => w.close()));
  metricsServer.close();
  await Promise.allSettled([runtime.close(), closePool()]);
  logger.info('worker shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
