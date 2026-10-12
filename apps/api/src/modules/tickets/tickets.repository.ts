import type { Queryable, TxClient } from '../../db/tx.js';

export interface TicketDetailsRow {
  id: string;
  bookingId: string;
  bookingStatus: string;
  userId: string;
  attendeeEmail: string;
  eventId: string;
  eventTitle: string;
  venue: string;
  startsAt: Date;
  organizerId: string;
  seatId: string;
  seatLabel: string;
  tier: string;
  pricePaise: number;
  qrToken: string;
  pdfKey: string | null;
  usedAt: Date | null;
  createdAt: Date;
}

const DETAILS_SELECT = `
  SELECT t.id, t.booking_id AS "bookingId", b.status AS "bookingStatus", b.user_id AS "userId", u.email AS "attendeeEmail",
         e.id AS "eventId", e.title AS "eventTitle", e.venue, e.starts_at AS "startsAt", e.organizer_id AS "organizerId",
         s.id AS "seatId", s.label AS "seatLabel", s.tier, s.price_paise AS "pricePaise",
         t.qr_token AS "qrToken", t.pdf_key AS "pdfKey", t.used_at AS "usedAt", t.created_at AS "createdAt"
    FROM tickets t
    JOIN bookings b ON b.id = t.booking_id
    JOIN users u ON u.id = b.user_id
    JOIN events e ON e.id = b.event_id
    JOIN seats s ON s.id = t.seat_id`;

/** Inserts tickets for the given seats; existing (booking, seat) pairs are left untouched. */
export async function insertTickets(
  tx: TxClient,
  bookingId: string,
  tickets: { id: string; seatId: string; qrToken: string }[],
): Promise<number> {
  const { rowCount } = await tx.query(
    `INSERT INTO tickets (id, booking_id, seat_id, qr_token)
     SELECT t.id, $1, t.seat_id, t.qr_token
       FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS t(id, seat_id, qr_token)
     ON CONFLICT (booking_id, seat_id) DO NOTHING`,
    [bookingId, tickets.map((t) => t.id), tickets.map((t) => t.seatId), tickets.map((t) => t.qrToken)],
  );
  return rowCount ?? 0;
}

export async function listTicketDetailsForBooking(db: Queryable, bookingId: string): Promise<TicketDetailsRow[]> {
  const { rows } = await db.query<TicketDetailsRow>(`${DETAILS_SELECT} WHERE t.booking_id = $1 ORDER BY s.label`, [bookingId]);
  return rows;
}

export async function listTicketDetailsForUser(db: Queryable, userId: string, bookingId?: string): Promise<TicketDetailsRow[]> {
  const { rows } = await db.query<TicketDetailsRow>(
    `${DETAILS_SELECT} WHERE b.user_id = $1 AND ($2::uuid IS NULL OR t.booking_id = $2) ORDER BY e.starts_at, s.label LIMIT 500`,
    [userId, bookingId ?? null],
  );
  return rows;
}

export async function findTicketDetails(db: Queryable, id: string): Promise<TicketDetailsRow | undefined> {
  const { rows } = await db.query<TicketDetailsRow>(`${DETAILS_SELECT} WHERE t.id = $1`, [id]);
  return rows[0];
}

export async function setTicketPdfKey(db: Queryable, id: string, key: string): Promise<void> {
  await db.query(`UPDATE tickets SET pdf_key = $2 WHERE id = $1 AND pdf_key IS NULL`, [id, key]);
}

/**
 * Admits a ticket in ONE statement. Under READ COMMITTED, a concurrent scan of the same
 * ticket blocks on the row lock and re-evaluates `used_at IS NULL` after the first
 * commits, so exactly one scanner gets a row back.
 */
export async function markTicketUsed(
  db: Queryable,
  input: { ticketId: string; qrToken: string; scannerId: string; isAdmin: boolean },
): Promise<{ usedAt: Date } | undefined> {
  const { rows } = await db.query<{ usedAt: Date }>(
    `UPDATE tickets t
        SET used_at = now(), used_by = $3
       FROM bookings b, events e
      WHERE t.id = $1 AND t.qr_token = $2 AND t.used_at IS NULL
        AND b.id = t.booking_id AND b.status = 'PAID'
        AND e.id = b.event_id AND ($4 OR e.organizer_id = $3)
      RETURNING t.used_at AS "usedAt"`,
    [input.ticketId, input.qrToken, input.scannerId, input.isAdmin],
  );
  return rows[0];
}
