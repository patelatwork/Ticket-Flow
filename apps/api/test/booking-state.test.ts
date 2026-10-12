import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { canTransition, IllegalTransitionError, transitionBooking } from '../src/modules/bookings/booking-state.js';
import { BOOKING_STATUSES, type BookingStatus } from '../src/modules/bookings/bookings.repository.js';
import { activeSeatCount, createPublishedEvent, createUser, idemKey, useTestServer } from './helpers.js';

const { url } = useTestServer();

async function heldBooking(): Promise<{ bookingId: string; eventId: string }> {
  const { eventId, seatIds } = await createPublishedEvent(2);
  const user = await createUser();
  const res = await request(url()).post('/bookings').set(user.auth).set('Idempotency-Key', idemKey()).send({ eventId, seatIds });
  return { bookingId: res.body.booking.id as string, eventId };
}

async function statusOf(id: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [id]);
  return rows[0]?.status;
}

describe('booking state machine', () => {
  it('allows exactly the documented transitions', () => {
    const allowed: Record<BookingStatus, BookingStatus[]> = {
      HELD: ['PAID', 'EXPIRED', 'CANCELLED'],
      PAID: ['REFUNDED'],
      EXPIRED: [],
      CANCELLED: [],
      REFUNDED: [],
    };
    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed[from].includes(to));
      }
    }
  });

  it('HELD -> PAID keeps the seats; PAID -> REFUNDED releases them', async () => {
    const { bookingId, eventId } = await heldBooking();

    await withTransaction((tx) => transitionBooking(tx, bookingId, 'PAID'));
    expect(await statusOf(bookingId)).toBe('PAID');
    expect(await activeSeatCount(eventId)).toBe(2);

    await withTransaction((tx) => transitionBooking(tx, bookingId, 'REFUNDED'));
    expect(await statusOf(bookingId)).toBe('REFUNDED');
    expect(await activeSeatCount(eventId)).toBe(0);
  });

  it('throws on illegal transitions and changes nothing', async () => {
    const { bookingId, eventId } = await heldBooking();
    await withTransaction((tx) => transitionBooking(tx, bookingId, 'EXPIRED'));

    await expect(withTransaction((tx) => transitionBooking(tx, bookingId, 'PAID'))).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(withTransaction((tx) => transitionBooking(tx, bookingId, 'HELD'))).rejects.toThrow(/EXPIRED to HELD/);
    expect(await statusOf(bookingId)).toBe('EXPIRED');
    expect(await activeSeatCount(eventId)).toBe(0);
  });

  it('a failing guard is a no-op, which makes repeated expiry idempotent', async () => {
    const { bookingId } = await heldBooking();
    const guard = (b: { status: BookingStatus }) => b.status === 'HELD';

    const first = await withTransaction((tx) => transitionBooking(tx, bookingId, 'EXPIRED', { guard }));
    const second = await withTransaction((tx) => transitionBooking(tx, bookingId, 'EXPIRED', { guard }));
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.booking.status).toBe('EXPIRED');
  });

  it('rolls back the status change if the surrounding transaction fails', async () => {
    const { bookingId, eventId } = await heldBooking();
    await expect(
      withTransaction(async (tx) => {
        await transitionBooking(tx, bookingId, 'CANCELLED');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await statusOf(bookingId)).toBe('HELD');
    expect(await activeSeatCount(eventId)).toBe(2);
  });

  it('the partial unique index rejects a second active claim even if application checks are bypassed', async () => {
    const { bookingId, eventId } = await heldBooking();
    const { rows } = await pool.query<{ seat_id: string; user_id: string }>(
      `SELECT bs.seat_id, b.user_id FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id WHERE bs.booking_id = $1 LIMIT 1`,
      [bookingId],
    );
    const seatId = rows[0]?.seat_id ?? '';
    const other = await createUser();
    const insert = withTransaction(async (tx) => {
      const b = await tx.query<{ id: string }>(
        `INSERT INTO bookings (user_id, event_id, hold_expires_at, total_paise, idempotency_key)
         VALUES ($1, $2, now() + interval '10 minutes', 1000, 'raw-insert') RETURNING id`,
        [other.id, eventId],
      );
      await tx.query(`INSERT INTO booking_seats (booking_id, seat_id, event_id) VALUES ($1, $2, $3)`, [b.rows[0]?.id, seatId, eventId]);
    });
    await expect(insert).rejects.toMatchObject({ code: '23505', constraint: 'booking_seats_one_active_per_seat' });
  });
});
