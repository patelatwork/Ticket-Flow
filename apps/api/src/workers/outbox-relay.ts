import { env } from '../config/env.js';
import type { Queryable } from '../db/tx.js';
import { logger } from '../lib/logger.js';
import { JOBS, OUTBOX_JOBS, type OutboxJobName } from '../queues/definitions.js';
import { claimOutboxBatch, markOutboxDispatched, markOutboxFailed, pruneDispatchedOutbox, type OutboxRow } from '../queues/outbox.js';

export interface EnqueueRequest {
  name: OutboxJobName;
  data: unknown;
  jobId: string;
  delayMs: number;
}

/** The relay's only dependency on BullMQ; tests substitute a fake to simulate crashes. */
export interface JobEnqueuer {
  enqueue(job: EnqueueRequest): Promise<void>;
}

function isOutboxJob(topic: string): topic is OutboxJobName {
  return (OUTBOX_JOBS as readonly string[]).includes(topic);
}

/**
 * One relay pass: claim a batch (short tx), enqueue each row (no tx open), mark the
 * successes dispatched. A crash anywhere in between leaves rows undispatched with a
 * lease that expires, so they are re-dispatched later. Delivery is therefore
 * at-least-once; deterministic job ids plus idempotent handlers make it effectively-once.
 */
export async function relayOnce(db: Queryable, enqueuer: JobEnqueuer, opts = { batchSize: env.OUTBOX_BATCH_SIZE, leaseSeconds: env.OUTBOX_LEASE_SECONDS }): Promise<number> {
  const rows = await claimOutboxBatch(db, opts.batchSize, opts.leaseSeconds);
  const dispatched: string[] = [];
  for (const row of rows) {
    try {
      await enqueuer.enqueue(toRequest(row));
      dispatched.push(row.id);
    } catch (err) {
      logger.error({ err, outboxId: row.id, topic: row.topic }, 'outbox dispatch failed; will retry');
      await markOutboxFailed(db, row.id, err instanceof Error ? err.message : String(err));
    }
  }
  await markOutboxDispatched(db, dispatched);
  return dispatched.length;
}

function toRequest(row: OutboxRow): EnqueueRequest {
  if (!isOutboxJob(row.topic)) throw new Error(`unknown outbox topic "${row.topic}"`);
  // Re-validate: the row may predate a schema change.
  const data: unknown = JOBS[row.topic].schema.parse(row.payload);
  return { name: row.topic, data, jobId: row.jobId, delayMs: row.delayMs };
}

export interface RelayHandle {
  stop(): Promise<void>;
}

/**
 * Polls the outbox until stopped. Drains back-to-back while batches come back full, then
 * sleeps for the poll interval. `stop()` resolves once the in-flight pass has finished.
 */
export function startOutboxRelay(db: Queryable, enqueuer: JobEnqueuer, intervalMs = env.OUTBOX_POLL_INTERVAL_MS): RelayHandle {
  let stopped = false;
  // A function so the compiler doesn't narrow `stopped` across the awaits below.
  const isStopped = (): boolean => stopped;
  let wake: (() => void) | undefined;
  let lastPrune = 0;

  const loop = async (): Promise<void> => {
    while (!isStopped()) {
      let moved = 0;
      try {
        moved = await relayOnce(db, enqueuer);
        if (Date.now() - lastPrune > 3_600_000) {
          lastPrune = Date.now();
          const pruned = await pruneDispatchedOutbox(db, 72);
          if (pruned) logger.info({ pruned }, 'pruned dispatched outbox rows');
        }
      } catch (err) {
        logger.error({ err }, 'outbox relay pass failed');
      }
      // Re-checked: stop() may have been called during the pass.
      if (moved < env.OUTBOX_BATCH_SIZE && !isStopped()) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, intervalMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  };

  const running = loop();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await running;
    },
  };
}
