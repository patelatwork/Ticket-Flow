import type { Queryable, TxClient } from '../../db/tx.js';

export const BOOKING_STATUSES = ['HELD', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface BookingRecord {
  id: string;
  userId: string;
  eventId: string;
  status: BookingStatus;
  holdExpiresAt: Date;
  /** Computed by Postgres (hold_expires_at <= now()) so app/DB clock skew cannot matter. */
  holdLapsed: boolean;
  totalPaise: number;
  createdAt: Date;
  updatedAt: Date;
}

const BOOKING_COLUMNS = `id, user_id AS "userId", event_id AS "eventId", status, hold_expires_at AS "holdExpiresAt",
  hold_expires_at <= now() AS "holdLapsed", total_paise AS "totalPaise", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function lockBooking(tx: TxClient, id: string): Promise<BookingRecord | undefined> {
  const { rows } = await tx.query<BookingRecord>(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0];
}

export async function findBooking(db: Queryable, id: string): Promise<BookingRecord | undefined> {
  const { rows } = await db.query<BookingRecord>(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`, [id]);
  return rows[0];
}

export async function updateBookingStatus(tx: TxClient, id: string, status: BookingStatus): Promise<BookingRecord> {
  const { rows } = await tx.query<BookingRecord>(
    `UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${BOOKING_COLUMNS}`,
    [id, status],
  );
  const row = rows[0];
  if (!row) throw new Error(`updateBookingStatus: booking ${id} vanished`);
  return row;
}

/** Keeps booking_seats.is_active in sync with the booking's status (see the partial unique index). */
export async function setBookingSeatsActive(tx: TxClient, bookingId: string, active: boolean): Promise<void> {
  await tx.query(`UPDATE booking_seats SET is_active = $2 WHERE booking_id = $1 AND is_active <> $2`, [bookingId, active]);
}

export async function listBookingSeatIds(db: Queryable, bookingId: string): Promise<string[]> {
  const { rows } = await db.query<{ seatId: string }>(
    `SELECT seat_id AS "seatId" FROM booking_seats WHERE booking_id = $1 ORDER BY seat_id`,
    [bookingId],
  );
  return rows.map((r) => r.seatId);
}

/** Locks several bookings in ascending id order (the global booking lock order). */
export async function lockBookingsInOrder(tx: TxClient, ids: string[]): Promise<BookingRecord[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.query<BookingRecord>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ids],
  );
  return rows;
}

export async function insertHeldBooking(
  tx: TxClient,
  booking: { userId: string; eventId: string; totalPaise: number; idempotencyKey: string; holdSeconds: number },
): Promise<BookingRecord> {
  const { rows } = await tx.query<BookingRecord>(
    `INSERT INTO bookings (user_id, event_id, status, hold_expires_at, total_paise, idempotency_key)
     VALUES ($1, $2, 'HELD', now() + make_interval(secs => $3), $4, $5)
     RETURNING ${BOOKING_COLUMNS}`,
    [booking.userId, booking.eventId, booking.holdSeconds, booking.totalPaise, booking.idempotencyKey],
  );
  const row = rows[0];
  if (!row) throw new Error('insertHeldBooking returned no row');
  return row;
}

export async function insertBookingSeats(tx: TxClient, bookingId: string, eventId: string, seatIds: string[]): Promise<void> {
  await tx.query(
    `INSERT INTO booking_seats (booking_id, seat_id, event_id, is_active)
     SELECT $1, seat_id, $3, true FROM unnest($2::uuid[]) AS seat_id`,
    [bookingId, seatIds, eventId],
  );
}

export interface LockedSeat {
  id: string;
  label: string;
  tier: string;
  pricePaise: number;
}

/**
 * Locks the requested seats in ascending id order. Every booking transaction acquires
 * seat locks in this same global order, so two transactions can never each hold a
 * lock the other is waiting for: no deadlocks, whatever order the client sent.
 * (LockRows sits above the Sort node in the plan, so rows are locked in sorted order.)
 */
export async function lockSeatsInOrder(tx: TxClient, eventId: string, seatIds: string[]): Promise<LockedSeat[]> {
  const { rows } = await tx.query<LockedSeat>(
    `SELECT id, label, tier, price_paise AS "pricePaise"
       FROM seats
      WHERE event_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [eventId, seatIds],
  );
  return rows;
}

export interface ActiveSeatClaim {
  seatId: string;
  bookingId: string;
  status: BookingStatus;
  holdLapsed: boolean;
}

export async function findActiveClaims(tx: TxClient, eventId: string, seatIds: string[]): Promise<ActiveSeatClaim[]> {
  const { rows } = await tx.query<ActiveSeatClaim>(
    `SELECT bs.seat_id AS "seatId", b.id AS "bookingId", b.status, b.hold_expires_at <= now() AS "holdLapsed"
       FROM booking_seats bs
       JOIN bookings b ON b.id = bs.booking_id
      WHERE bs.event_id = $1 AND bs.seat_id = ANY($2::uuid[]) AND bs.is_active`,
    [eventId, seatIds],
  );
  return rows;
}

export interface BookingDetailsRow {
  id: string;
  userId: string;
  eventId: string;
  eventTitle: string;
  eventStartsAt: Date;
  status: BookingStatus;
  holdExpiresAt: Date;
  totalPaise: number;
  createdAt: Date;
  seats: LockedSeat[];
}

const DETAILS_SELECT = `
  SELECT b.id, b.user_id AS "userId", b.event_id AS "eventId", e.title AS "eventTitle", e.starts_at AS "eventStartsAt",
         b.status, b.hold_expires_at AS "holdExpiresAt", b.total_paise AS "totalPaise", b.created_at AS "createdAt",
         json_agg(json_build_object('id', s.id, 'label', s.label, 'tier', s.tier, 'pricePaise', s.price_paise)
                  ORDER BY s.label) AS seats
    FROM bookings b
    JOIN events e ON e.id = b.event_id
    JOIN booking_seats bs ON bs.booking_id = b.id
    JOIN seats s ON s.id = bs.seat_id`;

export async function findBookingDetails(db: Queryable, id: string): Promise<BookingDetailsRow | undefined> {
  const { rows } = await db.query<BookingDetailsRow>(`${DETAILS_SELECT} WHERE b.id = $1 GROUP BY b.id, e.id`, [id]);
  return rows[0];
}

export async function listBookingDetailsForUser(db: Queryable, userId: string): Promise<BookingDetailsRow[]> {
  const { rows } = await db.query<BookingDetailsRow>(
    `${DETAILS_SELECT} WHERE b.user_id = $1 GROUP BY b.id, e.id ORDER BY b.created_at DESC LIMIT 200`,
    [userId],
  );
  return rows;
}
