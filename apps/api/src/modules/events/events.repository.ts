import pg from 'pg';
import type { Queryable, TxClient } from '../../db/tx.js';

export const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface EventRecord {
  id: string;
  organizerId: string;
  title: string;
  description: string;
  venue: string;
  startsAt: Date;
  status: EventStatus;
  createdAt: Date;
  updatedAt: Date;
}

const EVENT_COLUMNS = `id, organizer_id AS "organizerId", title, description, venue, starts_at AS "startsAt",
  status, created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function insertEvent(
  db: Queryable,
  event: { organizerId: string; title: string; description: string; venue: string; startsAt: Date },
): Promise<EventRecord> {
  const { rows } = await db.query<EventRecord>(
    `INSERT INTO events (organizer_id, title, description, venue, starts_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${EVENT_COLUMNS}`,
    [event.organizerId, event.title, event.description, event.venue, event.startsAt],
  );
  const row = rows[0];
  if (!row) throw new Error('insertEvent returned no row');
  return row;
}

export async function findEventById(db: Queryable, id: string): Promise<EventRecord | undefined> {
  const { rows } = await db.query<EventRecord>(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * Row-locks an event. Bookings take FOR SHARE (many may proceed concurrently);
 * status changes take FOR UPDATE so they wait for in-flight bookings and vice versa.
 */
export async function lockEvent(tx: TxClient, id: string, mode: 'share' | 'update'): Promise<EventRecord | undefined> {
  const lock = mode === 'share' ? 'FOR SHARE' : 'FOR UPDATE';
  const { rows } = await tx.query<EventRecord>(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1 ${lock}`, [id]);
  return rows[0];
}

export async function updateEvent(
  db: Queryable,
  id: string,
  patch: { title?: string; description?: string; venue?: string; startsAt?: Date },
): Promise<EventRecord | undefined> {
  const { rows } = await db.query<EventRecord>(
    `UPDATE events SET
       title = COALESCE($2, title),
       description = COALESCE($3, description),
       venue = COALESCE($4, venue),
       starts_at = COALESCE($5, starts_at),
       updated_at = now()
     WHERE id = $1
     RETURNING ${EVENT_COLUMNS}`,
    [id, patch.title ?? null, patch.description ?? null, patch.venue ?? null, patch.startsAt ?? null],
  );
  return rows[0];
}

export async function setEventStatus(tx: TxClient, id: string, status: EventStatus): Promise<EventRecord> {
  const { rows } = await tx.query<EventRecord>(
    `UPDATE events SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${EVENT_COLUMNS}`,
    [id, status],
  );
  const row = rows[0];
  if (!row) throw new Error(`setEventStatus: event ${id} vanished`);
  return row;
}

export async function listPublishedUpcoming(db: Queryable, limit: number, offset: number): Promise<EventRecord[]> {
  const { rows } = await db.query<EventRecord>(
    `SELECT ${EVENT_COLUMNS} FROM events
      WHERE status = 'PUBLISHED' AND starts_at > now()
      ORDER BY starts_at, id
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function listByOrganizer(db: Queryable, organizerId: string): Promise<EventRecord[]> {
  const { rows } = await db.query<EventRecord>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE organizer_id = $1 ORDER BY starts_at DESC, id`,
    [organizerId],
  );
  return rows;
}

export async function hasActiveBookings(db: Queryable, eventId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM booking_seats WHERE event_id = $1 AND is_active LIMIT 1`, [eventId]);
  return rows.length > 0;
}

// ---- seats ----

export interface SeatRecord {
  id: string;
  eventId: string;
  label: string;
  tier: string;
  pricePaise: number;
}

const SEAT_COLUMNS = `id, event_id AS "eventId", label, tier, price_paise AS "pricePaise"`;

export async function countSeats(db: Queryable, eventId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM seats WHERE event_id = $1`, [eventId]);
  return rows[0]?.n ?? 0;
}

/** Returns undefined if any label already exists for the event. */
export async function insertSeats(
  tx: TxClient,
  eventId: string,
  seats: { label: string; tier: string; pricePaise: number }[],
): Promise<SeatRecord[] | undefined> {
  try {
    const { rows } = await tx.query<SeatRecord>(
      `INSERT INTO seats (event_id, label, tier, price_paise)
       SELECT $1, t.label, t.tier, t.price
         FROM unnest($2::text[], $3::text[], $4::int[]) AS t(label, tier, price)
       RETURNING ${SEAT_COLUMNS}`,
      [eventId, seats.map((s) => s.label), seats.map((s) => s.tier), seats.map((s) => s.pricePaise)],
    );
    return rows;
  } catch (err) {
    if (err instanceof pg.DatabaseError && err.code === '23505' && err.constraint === 'seats_event_label_key') return undefined;
    throw err;
  }
}

export type DeleteSeatResult = 'deleted' | 'not_found' | 'has_bookings';

export async function deleteSeat(tx: TxClient, eventId: string, seatId: string): Promise<DeleteSeatResult> {
  try {
    const { rowCount } = await tx.query(`DELETE FROM seats WHERE id = $1 AND event_id = $2`, [seatId, eventId]);
    return rowCount ? 'deleted' : 'not_found';
  } catch (err) {
    // booking_seats keeps history; a seat that was ever booked cannot be removed.
    if (err instanceof pg.DatabaseError && err.code === '23503') return 'has_bookings';
    throw err;
  }
}

export type SeatState = 'AVAILABLE' | 'HELD' | 'SOLD';

export interface SeatMapRow extends SeatRecord {
  state: SeatState;
}

/**
 * A HELD booking whose hold has lapsed is reported as AVAILABLE: the next booking
 * attempt for that seat expires it (see bookings.service), so it is effectively free.
 */
export async function seatMap(db: Queryable, eventId: string): Promise<SeatMapRow[]> {
  const { rows } = await db.query<SeatMapRow>(
    `SELECT s.id, s.event_id AS "eventId", s.label, s.tier, s.price_paise AS "pricePaise",
            CASE
              WHEN b.status = 'PAID' THEN 'SOLD'
              WHEN b.status = 'HELD' AND b.hold_expires_at > now() THEN 'HELD'
              ELSE 'AVAILABLE'
            END AS state
       FROM seats s
       LEFT JOIN booking_seats bs ON bs.seat_id = s.id AND bs.event_id = s.event_id AND bs.is_active
       LEFT JOIN bookings b ON b.id = bs.booking_id
      WHERE s.event_id = $1
      -- Natural order: A1, A2, ..., A10, B1 (letters prefix, then the numeric part).
      ORDER BY substring(s.label FROM '^[^0-9]*'), substring(s.label FROM '[0-9]+')::numeric NULLS FIRST, s.label`,
    [eventId],
  );
  return rows;
}
