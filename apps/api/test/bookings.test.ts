import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { activeSeatCount, createPublishedEvent, createUser, idemKey, useTestServer } from './helpers.js';

const { url } = useTestServer();

function book(token: { Authorization: string }, key: string | undefined, body: { eventId: string; seatIds: string[] }) {
  const req = request(url()).post('/bookings').set(token);
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(body);
}

describe('POST /bookings', () => {
  it('holds the seats for 10 minutes and totals the price in paise', async () => {
    const { eventId, seatIds } = await createPublishedEvent(3);
    const user = await createUser();
    const before = Date.now();

    const res = await book(user.auth, idemKey(), { eventId, seatIds: [seatIds[0] ?? '', seatIds[1] ?? ''] });

    expect(res.status).toBe(201);
    expect(res.body.booking).toMatchObject({ eventId, status: 'HELD', totalPaise: 2000 });
    expect(res.body.booking.seats).toHaveLength(2);
    const holdMs = new Date(res.body.booking.holdExpiresAt as string).getTime() - before;
    expect(holdMs).toBeGreaterThan(590_000);
    expect(holdMs).toBeLessThan(610_000);

    const map = await request(url()).get(`/events/${eventId}/seats`);
    const states = Object.fromEntries((map.body.seats as { id: string; state: string }[]).map((s) => [s.id, s.state]));
    expect(states[seatIds[0] ?? '']).toBe('HELD');
    expect(states[seatIds[2] ?? '']).toBe('AVAILABLE');
  });

  it('requires a well-formed Idempotency-Key header', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const user = await createUser();
    const missing = await book(user.auth, undefined, { eventId, seatIds });
    expect(missing.status).toBe(400);
    expect((await book(user.auth, 'short', { eventId, seatIds })).status).toBe(400);
  });

  it('returns 409 with exactly the conflicting seat ids', async () => {
    const { eventId, seatIds } = await createPublishedEvent(3);
    const [s1, s2, s3] = seatIds as [string, string, string];
    await book((await createUser()).auth, idemKey(), { eventId, seatIds: [s2] });

    const res = await book((await createUser()).auth, idemKey(), { eventId, seatIds: [s1, s2, s3] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_UNAVAILABLE');
    expect(res.body.error.details.seatIds).toEqual([s2]);
    // All-or-nothing: the free seats were not partially booked.
    expect(await activeSeatCount(eventId)).toBe(1);
  });

  it('rejects seats from another event and unknown/unpublished events', async () => {
    const a = await createPublishedEvent(1);
    const b = await createPublishedEvent(1);
    const user = await createUser();
    const cross = await book(user.auth, idemKey(), { eventId: a.eventId, seatIds: b.seatIds });
    expect(cross.status).toBe(422);
    expect(cross.body.error.details.seatIds).toEqual(b.seatIds);

    await pool.query(`UPDATE events SET status = 'DRAFT' WHERE id = $1`, [a.eventId]);
    expect((await book(user.auth, idemKey(), { eventId: a.eventId, seatIds: a.seatIds })).status).toBe(404);
  });

  it('lets an owner cancel a HELD booking, freeing the seats; cancelling twice is an illegal transition', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const owner = await createUser();
    const created = await book(owner.auth, idemKey(), { eventId, seatIds });
    const id = created.body.booking.id as string;

    expect((await request(url()).post(`/bookings/${id}/cancel`).set((await createUser()).auth)).status).toBe(404);
    const cancelled = await request(url()).post(`/bookings/${id}/cancel`).set(owner.auth);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking.status).toBe('CANCELLED');

    const again = await request(url()).post(`/bookings/${id}/cancel`).set(owner.auth);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ILLEGAL_TRANSITION');

    expect((await book((await createUser()).auth, idemKey(), { eventId, seatIds })).status).toBe(201);
  });

  it('reclaims seats from a lapsed hold that the expiry job has not processed yet', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const first = await book((await createUser()).auth, idemKey(), { eventId, seatIds });
    const staleId = first.body.booking.id as string;
    await pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [staleId]);

    const map = await request(url()).get(`/events/${eventId}/seats`);
    expect(map.body.seats[0].state).toBe('AVAILABLE');

    const second = await book((await createUser()).auth, idemKey(), { eventId, seatIds });
    expect(second.status).toBe(201);
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [staleId]);
    expect(rows[0]?.status).toBe('EXPIRED');
    expect(await activeSeatCount(eventId)).toBe(1);
  });

  it('lists and fetches only the caller’s bookings', async () => {
    const { eventId, seatIds } = await createPublishedEvent(2);
    const alice = await createUser();
    const bob = await createUser();
    const created = await book(alice.auth, idemKey(), { eventId, seatIds: [seatIds[0] ?? ''] });
    const id = created.body.booking.id as string;

    expect((await request(url()).get('/bookings').set(alice.auth)).body.bookings).toHaveLength(1);
    expect((await request(url()).get('/bookings').set(bob.auth)).body.bookings).toHaveLength(0);
    expect((await request(url()).get(`/bookings/${id}`).set(alice.auth)).body.booking.id).toBe(id);
    expect((await request(url()).get(`/bookings/${id}`).set(bob.auth)).status).toBe(404);
  });
});

describe('idempotency', () => {
  it('replays the original response for the same key without creating a second booking', async () => {
    const { eventId, seatIds } = await createPublishedEvent(2);
    const user = await createUser();
    const key = idemKey();

    const first = await book(user.auth, key, { eventId, seatIds });
    // Same seats in a different order are the same request.
    const replay = await book(user.auth, key, { eventId, seatIds: [...seatIds].reverse() });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE user_id = $1`, [user.id]);
    expect(rows[0]?.n).toBe(1);
  });

  it('replays a 409 too, even after the seat becomes free', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const holder = await createUser();
    const held = await book(holder.auth, idemKey(), { eventId, seatIds });

    const user = await createUser();
    const key = idemKey();
    expect((await book(user.auth, key, { eventId, seatIds })).status).toBe(409);

    await request(url()).post(`/bookings/${held.body.booking.id as string}/cancel`).set(holder.auth);
    const replay = await book(user.auth, key, { eventId, seatIds });
    expect(replay.status).toBe(409);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // A new key is a new attempt.
    expect((await book(user.auth, idemKey(), { eventId, seatIds })).status).toBe(201);
  });

  it('rejects reuse of a key with a different request body', async () => {
    const { eventId, seatIds } = await createPublishedEvent(2);
    const user = await createUser();
    const key = idemKey();
    await book(user.auth, key, { eventId, seatIds: [seatIds[0] ?? ''] });
    const res = await book(user.auth, key, { eventId, seatIds: [seatIds[1] ?? ''] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes keys per user', async () => {
    const { eventId, seatIds } = await createPublishedEvent(2);
    const key = idemKey();
    expect((await book((await createUser()).auth, key, { eventId, seatIds: [seatIds[0] ?? ''] })).status).toBe(201);
    expect((await book((await createUser()).auth, key, { eventId, seatIds: [seatIds[1] ?? ''] })).status).toBe(201);
  });

  it('does not store validation failures, so the key can be retried', async () => {
    const a = await createPublishedEvent(1);
    const b = await createPublishedEvent(1);
    const user = await createUser();
    const key = idemKey();
    expect((await book(user.auth, key, { eventId: a.eventId, seatIds: b.seatIds })).status).toBe(422);
    // Different body with the same key is accepted because nothing was stored.
    expect((await book(user.auth, key, { eventId: a.eventId, seatIds: a.seatIds })).status).toBe(201);
  });
});
