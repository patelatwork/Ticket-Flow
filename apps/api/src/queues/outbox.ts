import type { Queryable, TxClient } from '../db/tx.js';
import { JOBS, type JobData, type OutboxJobName } from './definitions.js';

export interface OutboxOptions {
  /** Deterministic BullMQ job id (see `jobId()`); dedupes repeated dispatches. */
  jobId: string;
  /** Run no earlier than this. Omit to run immediately. */
  runAt?: Date;
}

/**
 * Records a job in the outbox inside the caller's transaction. The job exists if and only
 * if the transaction commits: no lost jobs (crash after commit) and no phantom jobs
 * (rollback). Requires a TxClient, so it cannot be called outside a transaction.
 */
export async function addToOutbox<N extends OutboxJobName>(
  tx: TxClient,
  name: N,
  data: JobData<N>,
  options: OutboxOptions,
): Promise<void> {
  const payload: unknown = JOBS[name].schema.parse(data);
  await tx.query(`INSERT INTO outbox (topic, payload, job_id, run_at) VALUES ($1, $2::jsonb, $3, $4)`, [
    name,
    JSON.stringify(payload),
    options.jobId,
    options.runAt ?? null,
  ]);
}

export interface OutboxRow {
  id: string;
  topic: string;
  payload: unknown;
  jobId: string;
  /** Milliseconds until run_at, measured on the DB clock at claim time (0 if due). */
  delayMs: number;
  attempts: number;
}

/**
 * Claims up to `limit` undispatched rows by stamping a lease, in a short transaction of
 * its own. FOR UPDATE SKIP LOCKED lets several relays run concurrently without blocking
 * or double-claiming. Rows whose lease lapsed (the relay died mid-dispatch) are
 * claimable again.
 */
export async function claimOutboxBatch(db: Queryable, limit: number, leaseSeconds: number): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `UPDATE outbox o
        SET claimed_until = now() + make_interval(secs => $2), attempts = o.attempts + 1
       FROM (
         SELECT id FROM outbox
          WHERE dispatched_at IS NULL AND (claimed_until IS NULL OR claimed_until < now())
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ) due
      WHERE o.id = due.id
      RETURNING o.id::text, o.topic, o.payload, o.job_id AS "jobId", o.attempts,
                GREATEST(0, floor(extract(epoch FROM (o.run_at - now())) * 1000))::bigint::int AS "delayMs"`,
    [limit, leaseSeconds],
  );
  // GREATEST ignores NULL, so a NULL run_at yields 0 (run now).
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Safe even if the lease lapsed and another relay re-dispatched the row: both adds used
 * the same job id, so BullMQ kept one job.
 */
export async function markOutboxDispatched(db: Queryable, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(`UPDATE outbox SET dispatched_at = now(), claimed_until = NULL, last_error = NULL WHERE id = ANY($1::bigint[])`, [ids]);
}

/** Releases the lease with a backoff so a poison row doesn't hot-loop. */
export async function markOutboxFailed(db: Queryable, id: string, error: string): Promise<void> {
  await db.query(
    `UPDATE outbox
        SET last_error = $2,
            claimed_until = now() + make_interval(secs => LEAST(300, power(2, LEAST(attempts, 8)))::int)
      WHERE id = $1::bigint`,
    [id, error.slice(0, 2000)],
  );
}

/** Housekeeping: dispatched rows are only useful for a short audit window. */
export async function pruneDispatchedOutbox(db: Queryable, olderThanHours: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM outbox WHERE dispatched_at < now() - make_interval(hours => $1)`,
    [olderThanHours],
  );
  return rowCount ?? 0;
}

export async function outboxBacklog(db: Queryable): Promise<{ pending: number; oldestAgeSeconds: number }> {
  const { rows } = await db.query<{ pending: number; oldest: number | null }>(
    `SELECT count(*)::int AS pending, extract(epoch FROM now() - min(created_at))::float8 AS oldest
       FROM outbox WHERE dispatched_at IS NULL`,
  );
  return { pending: rows[0]?.pending ?? 0, oldestAgeSeconds: rows[0]?.oldest ?? 0 };
}
