import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { listDeadLetters, moveToDeadLetter, retryDeadLetter } from '../src/modules/admin/dlq.service.js';
import { createRedis } from '../src/queues/connection.js';
import { JOBS } from '../src/queues/definitions.js';
import { QueueRegistry } from '../src/queues/queues.js';
import { relayOnce } from '../src/workers/outbox-relay.js';
import { createProcessor } from '../src/workers/processors.js';
import { InMemoryMockOrderStore } from '../src/modules/payments/providers/mock.js';
import { bookingStatus, bookSeats, createPublishedEvent, createUser, lapseHold, useTestServer } from './helpers.js';

/**
 * Real BullMQ against a real Redis. Runs only when TEST_REDIS_URL is set, e.g.
 *   docker compose --profile test up -d postgres-test redis-test
 *   TEST_REDIS_URL=redis://localhost:6380 TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/ticketflow_test npm test
 */
const enabled = Boolean(process.env.TEST_REDIS_URL);
const { url } = useTestServer();

describe.skipIf(!enabled)('BullMQ integration (Redis)', () => {
  let redis: Redis;
  let queues: QueueRegistry;
  let worker: Worker | undefined;

  beforeAll(async () => {
    redis = createRedis('client');
    await redis.flushdb();
    queues = new QueueRegistry(redis);
  });

  afterAll(async () => {
    await worker?.close();
    await queues.close();
    await redis.quit();
  });

  it('outbox -> relay -> BullMQ -> worker expires the hold', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const bookingId = await bookSeats(url(), await createUser(), eventId, seatIds);
    await lapseHold(bookingId);
    // Make the outbox row due now (it was written with run_at = the original expiry).
    await pool.query(`UPDATE outbox SET run_at = now()`);

    const enqueuer = {
      enqueue: async ({ name, data, jobId, delayMs }: { name: keyof typeof JOBS; data: unknown; jobId: string; delayMs: number }) => {
        await queues.get(JOBS[name].queue).add(name, data, { jobId, delay: delayMs });
      },
    };
    expect(await relayOnce(pool, enqueuer, { batchSize: 10, leaseSeconds: 30 })).toBe(1);
    // A second dispatch of the same row (lease expired after a crash) is deduped by job id.
    await enqueuer.enqueue({ name: 'hold-expiry', data: { bookingId }, jobId: `hold-expiry_${bookingId}`, delayMs: 0 });

    const completed: unknown[] = [];
    worker = new Worker(
      'hold-expiry',
      createProcessor('hold-expiry', {
        queues,
        mockDelivery: { store: new InMemoryMockOrderStore(), config: { secret: 'x'.repeat(16), delayMs: 0, outcome: 'success', duplicates: 0, outOfOrder: false, dropWebhooks: false }, post: () => Promise.resolve(200) },
      }),
      { connection: createRedis('worker'), prefix: env.QUEUE_PREFIX },
    );
    await new Promise<void>((resolve) => {
      worker?.on('completed', (job) => {
        completed.push(job.returnvalue);
        resolve();
      });
    });
    expect(completed).toEqual([{ result: 'expired' }]);
    expect(await bookingStatus(bookingId)).toBe('EXPIRED');
    const counts = await queues.get('hold-expiry').getJobCounts('completed', 'waiting', 'delayed');
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('dead-letters a job and retries it from the DLQ', async () => {
    const queue = queues.get('tickets');
    const job = await queue.add('generate-tickets', { bookingId: '00000000-0000-4000-8000-000000000000' }, { jobId: 'gt_dlq_test' });
    await moveToDeadLetter(queues, job, 'tickets', 'simulated permanent failure');

    const dead = await listDeadLetters(queues, 10);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ queue: 'tickets', jobName: 'generate-tickets', failedReason: 'simulated permanent failure' });

    const { requeuedAs } = await retryDeadLetter(queues, dead[0]?.id ?? '');
    expect(await queue.getJob(requeuedAs)).toBeDefined();
    expect(await listDeadLetters(queues, 10)).toHaveLength(0);
  });
});
