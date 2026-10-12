import request from 'supertest';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { pool } from '../src/db/pool.js';
import { activeSeatCount, createPublishedEvent, createUser, createUsers, idemKey, shuffle, useTestServer } from './helpers.js';

const { url } = useTestServer();

interface BookingResponse {
  status: number;
  body: {
    booking?: { id: string; seats: { id: string }[] };
    error?: { code: string; details?: { seatIds?: string[] } };
  };
  headers: Record<string, string>;
}

async function bookConcurrently(
  attempts: { token: { Authorization: string }; key: string; eventId: string; seatIds: string[] }[],
): Promise<BookingResponse[]> {
  return Promise.all(
    attempts.map(
      async (a) =>
        (await request(url())
          .post('/bookings')
          .set(a.token)
          .set('Idempotency-Key', a.key)
          .send({ eventId: a.eventId, seatIds: a.seatIds })) as unknown as BookingResponse,
    ),
  );
}

describe('booking under concurrency', () => {
  it('50 parallel requests for the same seat: exactly one succeeds, 49 get 409', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const users = await createUsers(50);

    const responses = await bookConcurrently(users.map((u) => ({ token: u.auth, key: idemKey(), eventId, seatIds })));

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(49);
    for (const r of responses.filter((x) => x.status === 409)) {
      expect(r.body.error?.details?.seatIds).toEqual(seatIds);
    }

    expect(await activeSeatCount(eventId)).toBe(1);
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE event_id = $1`, [eventId]);
    expect(rows[0]?.n).toBe(1);
  });

  it('20 parallel retries with the same idempotency key create one booking and all see it', async () => {
    const { eventId, seatIds } = await createPublishedEvent(2);
    const user = await createUser();
    const key = idemKey();

    const responses = await bookConcurrently(Array.from({ length: 20 }, () => ({ token: user.auth, key, eventId, seatIds })));

    expect(responses.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(responses.map((r) => r.body.booking?.id));
    expect(ids.size).toBe(1);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(19);
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE user_id = $1`, [user.id]);
    expect(rows[0]?.n).toBe(1);
  });

  it('overlapping multi-seat requests in random orders never deadlock or double-book', async () => {
    for (let round = 0; round < 3; round++) {
      const { eventId, seatIds } = await createPublishedEvent(12);
      const users = await createUsers(60);
      const attempts = users.map((u, i) => {
        // Half the requests take a forward slice, half the same slice reversed: worst case for lock ordering.
        const start = i % 9;
        const slice = seatIds.slice(start, start + 2 + (i % 3));
        const ordered = i % 2 === 0 ? slice : [...slice].reverse();
        return { token: u.auth, key: idemKey(), eventId, seatIds: i % 5 === 0 ? shuffle(ordered) : ordered };
      });

      const responses = await bookConcurrently(shuffle(attempts));

      // No 5xx: a deadlock would surface as 503 RETRYABLE_CONFLICT.
      expect(responses.map((r) => r.status).filter((s) => s !== 201 && s !== 409)).toEqual([]);

      const won = responses.filter((r) => r.status === 201).flatMap((r) => r.body.booking?.seats.map((s) => s.id) ?? []);
      expect(new Set(won).size).toBe(won.length); // no seat in two successful bookings
      expect(await activeSeatCount(eventId)).toBe(won.length);

      // Every 409 names only seats that some winner actually holds.
      const wonSet = new Set(won);
      for (const r of responses.filter((x) => x.status === 409)) {
        const conflicting = r.body.error?.details?.seatIds ?? [];
        expect(conflicting.length).toBeGreaterThan(0);
        expect(conflicting.every((id) => wonSet.has(id))).toBe(true);
      }
    }
  });

  it('control: locking the same seats in opposite order WITHOUT a global order does deadlock', async () => {
    // Shows the previous test exercises a real hazard: Postgres aborts one of two
    // transactions that lock {s1, s2} in opposite orders.
    const { seatIds } = await createPublishedEvent(2);
    const [s1, s2] = seatIds as [string, string];
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query('SELECT 1 FROM seats WHERE id = $1 FOR UPDATE', [s1]);
      await b.query('SELECT 1 FROM seats WHERE id = $1 FOR UPDATE', [s2]);
      // The deadlock victim keeps its locks until ROLLBACK, so roll it back immediately
      // or the survivor would wait forever.
      const lockOrRollback = (client: pg.PoolClient, seatId: string) =>
        client.query('SELECT 1 FROM seats WHERE id = $1 FOR UPDATE', [seatId]).catch(async (err: unknown) => {
          await client.query('ROLLBACK');
          throw err;
        });
      const results = await Promise.allSettled([lockOrRollback(a, s2), lockOrRollback(b, s1)]);
      const deadlocks = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof pg.DatabaseError && r.reason.code === '40P01',
      );
      expect(deadlocks).toHaveLength(1);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });
});
