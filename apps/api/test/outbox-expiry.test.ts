import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { transitionBooking } from '../src/modules/bookings/booking-state.js';
import { expireHold } from '../src/modules/bookings/hold-expiry.service.js';
import { addToOutbox, claimOutboxBatch } from '../src/queues/outbox.js';
import { relayOnce, type EnqueueRequest, type JobEnqueuer } from '../src/workers/outbox-relay.js';
import {
  activeSeatCount,
  bookingStatus,
  bookSeats,
  createPublishedEvent,
  createUser,
  lapseHold,
  outboxRows,
  useTestServer,
} from './helpers.js';

const { url } = useTestServer();

class RecordingEnqueuer implements JobEnqueuer {
  readonly jobs: EnqueueRequest[] = [];
  enqueue(job: EnqueueRequest): Promise<void> {
    this.jobs.push(job);
    return Promise.resolve();
  }
}

/** Simulates the relay process dying mid-dispatch: the enqueue call never completes. */
class CrashingEnqueuer implements JobEnqueuer {
  calls = 0;
  enqueue(): Promise<void> {
    this.calls++;
    return Promise.reject(new Error('simulated crash: process killed before enqueue completed'));
  }
}

const relayOpts = { batchSize: 100, leaseSeconds: 30 };

async function expireLeases(): Promise<void> {
  await pool.query(`UPDATE outbox SET claimed_until = now() - interval '1 second' WHERE dispatched_at IS NULL`);
}

describe('transactional outbox', () => {
  it('booking creation writes a hold-expiry job in the same transaction, delayed until hold_expires_at', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const bookingId = await bookSeats(url(), await createUser(), eventId, seatIds);

    const rows = await outboxRows('hold-expiry');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ bookingId });
    expect(rows[0]?.jobId).toBe(`hold-expiry_${bookingId}`);

    const [claimed] = await claimOutboxBatch(pool, 10, 30);
    // HOLD_TTL_SECONDS is 600 in tests.
    expect(claimed?.delayMs).toBeGreaterThan(590_000);
    expect(claimed?.delayMs).toBeLessThanOrEqual(600_000);
  });

  it('a rolled-back transaction leaves no job behind (no phantom jobs)', async () => {
    const { eventId } = await createPublishedEvent(1);
    await expect(
      withTransaction(async (tx) => {
        await addToOutbox(tx, 'generate-tickets', { bookingId: eventId }, { jobId: 'x' });
        throw new Error('business rule failed after the outbox write');
      }),
    ).rejects.toThrow();
    expect(await outboxRows()).toHaveLength(0);
  });

  it('never loses a job when the process crashes between commit and enqueue', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const bookingId = await bookSeats(url(), await createUser(), eventId, seatIds);
    // The booking is committed. Now the relay "crashes" while dispatching.
    const crashing = new CrashingEnqueuer();
    expect(await relayOnce(pool, crashing, relayOpts)).toBe(0);
    expect(crashing.calls).toBe(1);
    expect((await outboxRows())[0]?.dispatchedAt).toBeNull();

    // A fresh relay (after restart) picks the row up once its lease/backoff lapses.
    await expireLeases();
    const healthy = new RecordingEnqueuer();
    expect(await relayOnce(pool, healthy, relayOpts)).toBe(1);
    expect(healthy.jobs).toEqual([expect.objectContaining({ name: 'hold-expiry', data: { bookingId }, jobId: `hold-expiry_${bookingId}` })]);
    expect((await outboxRows())[0]?.dispatchedAt).not.toBeNull();

    // Nothing left to dispatch.
    expect(await relayOnce(pool, healthy, relayOpts)).toBe(0);
  });

  it('a crash after enqueue but before marking dispatched re-sends with the SAME job id (queue dedupes)', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    await bookSeats(url(), await createUser(), eventId, seatIds);

    // Claimed and enqueued, but the process died before markOutboxDispatched ran.
    const [claimed] = await claimOutboxBatch(pool, 10, 30);
    const firstJobId = claimed?.jobId;
    expect((await outboxRows())[0]?.dispatchedAt).toBeNull();

    // While the lease is live, no other relay can take it.
    expect(await claimOutboxBatch(pool, 10, 30)).toHaveLength(0);

    await expireLeases();
    const healthy = new RecordingEnqueuer();
    await relayOnce(pool, healthy, relayOpts);
    expect(healthy.jobs.map((j) => j.jobId)).toEqual([firstJobId]);
  });

  it('concurrent relays never claim the same row (FOR UPDATE SKIP LOCKED)', async () => {
    const { eventId, seatIds } = await createPublishedEvent(30);
    const user = await createUser();
    for (const seatId of seatIds) await bookSeats(url(), user, eventId, [seatId]);

    const batches = await Promise.all(Array.from({ length: 6 }, () => claimOutboxBatch(pool, 10, 30)));
    const ids = batches.flat().map((r) => r.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });
});

describe('hold-expiry job', () => {
  it('expires a lapsed hold and releases the seats for rebooking', async () => {
    const { eventId, seatIds } = await createPublishedEvent(2);
    const bookingId = await bookSeats(url(), await createUser(), eventId, seatIds);
    await lapseHold(bookingId);

    expect(await expireHold(bookingId)).toEqual({ result: 'expired' });
    expect(await bookingStatus(bookingId)).toBe('EXPIRED');
    expect(await activeSeatCount(eventId)).toBe(0);
    await expect(bookSeats(url(), await createUser(), eventId, seatIds)).resolves.toEqual(expect.any(String));
  });

  it('is idempotent: running twice is a no-op the second time', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const bookingId = await bookSeats(url(), await createUser(), eventId, seatIds);
    await lapseHold(bookingId);

    const [a, b] = await Promise.all([expireHold(bookingId), expireHold(bookingId)]);
    expect([a.result, b.result].sort()).toEqual(['expired', 'noop']);
    expect(await expireHold(bookingId)).toEqual({ result: 'noop', status: 'EXPIRED' });
  });

  it('is a no-op for an already-PAID booking, even after its hold time', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const bookingId = await bookSeats(url(), await createUser(), eventId, seatIds);
    await withTransaction((tx) => transitionBooking(tx, bookingId, 'PAID'));
    await lapseHold(bookingId);

    expect(await expireHold(bookingId)).toEqual({ result: 'noop', status: 'PAID' });
    expect(await bookingStatus(bookingId)).toBe('PAID');
    expect(await activeSeatCount(eventId)).toBe(1);
  });

  it('a job that fires before the hold lapses (clock skew) reschedules instead of expiring', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const bookingId = await bookSeats(url(), await createUser(), eventId, seatIds);

    const outcome = await expireHold(bookingId);
    expect(outcome.result).toBe('not-due');
    expect(await bookingStatus(bookingId)).toBe('HELD');
  });

  it('a missing booking is a no-op, not a retry loop', async () => {
    expect(await expireHold('00000000-0000-4000-8000-000000000000')).toEqual({ result: 'noop', status: 'MISSING' });
  });
});
