import { pool } from '../../db/pool.js';
import type { AuthUser } from '../auth/tokens.js';

export interface EventSales {
  eventId: string;
  title: string;
  startsAt: string;
  status: string;
  totalSeats: number;
  seatsSold: number;
  seatsHeld: number;
  bookingsPaid: number;
  grossPaise: number;
  refundedPaise: number;
}

export interface DailyReportDto {
  reportDate: string;
  bookingsPaid: number;
  ticketsSold: number;
  grossPaise: number;
  refundedPaise: number;
  generatedAt: string;
}

/**
 * Generates (or regenerates) one organizer's report for one UTC day. A single aggregate
 * query plus an upsert, so the job is idempotent and safe to re-run for any past date.
 */
export async function generateDailySalesReport(organizerId: string, reportDate: string): Promise<DailyReportDto> {
  const { rows } = await pool.query<{
    bookingsPaid: number;
    ticketsSold: number;
    grossPaise: string;
    refundedPaise: string;
    byEvent: unknown;
    generatedAt: Date;
  }>(
    `WITH day_bounds AS (
       SELECT ($2::date)::timestamp AT TIME ZONE 'UTC' AS t0, (($2::date) + 1)::timestamp AT TIME ZONE 'UTC' AS t1
     ), sales AS (
       SELECT e.id AS event_id, e.title, p.amount_paise,
              (SELECT count(*) FROM booking_seats bs WHERE bs.booking_id = b.id)::int AS seats
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN events e ON e.id = b.event_id, day_bounds d
        WHERE e.organizer_id = $1 AND p.succeeded_at >= d.t0 AND p.succeeded_at < d.t1
     ), refunds AS (
       SELECT e.id AS event_id, p.amount_paise
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN events e ON e.id = b.event_id, day_bounds d
        WHERE e.organizer_id = $1 AND p.refunded_at >= d.t0 AND p.refunded_at < d.t1
     ), per_event AS (
       SELECT ev.id AS event_id, ev.title,
              (SELECT count(*) FROM sales s WHERE s.event_id = ev.id)::int AS bookings_paid,
              (SELECT COALESCE(sum(seats), 0) FROM sales s WHERE s.event_id = ev.id)::int AS tickets_sold,
              (SELECT COALESCE(sum(amount_paise), 0) FROM sales s WHERE s.event_id = ev.id)::bigint AS gross_paise,
              (SELECT COALESCE(sum(amount_paise), 0) FROM refunds r WHERE r.event_id = ev.id)::bigint AS refunded_paise
         FROM events ev
        WHERE ev.id IN (SELECT event_id FROM sales UNION SELECT event_id FROM refunds)
     )
     INSERT INTO reports (organizer_id, report_date, bookings_paid, tickets_sold, gross_paise, refunded_paise, by_event, generated_at)
     SELECT $1, $2::date,
            COALESCE(sum(bookings_paid), 0)::int, COALESCE(sum(tickets_sold), 0)::int,
            COALESCE(sum(gross_paise), 0)::bigint, COALESCE(sum(refunded_paise), 0)::bigint,
            COALESCE(jsonb_agg(jsonb_build_object(
              'eventId', event_id, 'title', title, 'bookingsPaid', bookings_paid, 'ticketsSold', tickets_sold,
              'grossPaise', gross_paise, 'refundedPaise', refunded_paise) ORDER BY title) FILTER (WHERE event_id IS NOT NULL), '[]'::jsonb),
            now()
       FROM per_event
     ON CONFLICT (organizer_id, report_date) DO UPDATE SET
       bookings_paid = EXCLUDED.bookings_paid, tickets_sold = EXCLUDED.tickets_sold,
       gross_paise = EXCLUDED.gross_paise, refunded_paise = EXCLUDED.refunded_paise,
       by_event = EXCLUDED.by_event, generated_at = EXCLUDED.generated_at
     RETURNING bookings_paid AS "bookingsPaid", tickets_sold AS "ticketsSold", gross_paise::text AS "grossPaise",
               refunded_paise::text AS "refundedPaise", by_event AS "byEvent", generated_at AS "generatedAt"`,
    [organizerId, reportDate],
  );
  const row = rows[0];
  if (!row) throw new Error('report upsert returned no row');
  return {
    reportDate,
    bookingsPaid: row.bookingsPaid,
    ticketsSold: row.ticketsSold,
    grossPaise: Number(row.grossPaise),
    refundedPaise: Number(row.refundedPaise),
    generatedAt: row.generatedAt.toISOString(),
  };
}

/** Organizers with at least one event: the fan-out list for the nightly report. */
export async function listReportableOrganizers(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT DISTINCT organizer_id AS id FROM events ORDER BY 1`);
  return rows.map((r) => r.id);
}

export function yesterdayUtc(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.toISOString().slice(0, 10);
}

/** Live per-event numbers for the organizer dashboard, plus the last 14 daily reports. */
export async function getSalesSummary(user: AuthUser): Promise<{ events: EventSales[]; daily: DailyReportDto[] }> {
  const events = await pool.query<{
    eventId: string;
    title: string;
    startsAt: Date;
    status: string;
    totalSeats: number;
    seatsSold: number;
    seatsHeld: number;
    bookingsPaid: number;
    grossPaise: string;
    refundedPaise: string;
  }>(
    `SELECT e.id AS "eventId", e.title, e.starts_at AS "startsAt", e.status,
            (SELECT count(*) FROM seats s WHERE s.event_id = e.id)::int AS "totalSeats",
            (SELECT count(*) FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
              WHERE bs.event_id = e.id AND bs.is_active AND b.status = 'PAID')::int AS "seatsSold",
            (SELECT count(*) FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
              WHERE bs.event_id = e.id AND bs.is_active AND b.status = 'HELD' AND b.hold_expires_at > now())::int AS "seatsHeld",
            (SELECT count(*) FROM bookings b WHERE b.event_id = e.id AND b.status = 'PAID')::int AS "bookingsPaid",
            (SELECT COALESCE(sum(p.amount_paise), 0) FROM payments p JOIN bookings b ON b.id = p.booking_id
              WHERE b.event_id = e.id AND p.succeeded_at IS NOT NULL)::text AS "grossPaise",
            (SELECT COALESCE(sum(p.amount_paise), 0) FROM payments p JOIN bookings b ON b.id = p.booking_id
              WHERE b.event_id = e.id AND p.status = 'REFUNDED')::text AS "refundedPaise"
       FROM events e
      WHERE $2 OR e.organizer_id = $1
      ORDER BY e.starts_at DESC
      LIMIT 200`,
    [user.id, user.role === 'admin'],
  );
  const daily = await pool.query<{
    reportDate: string;
    bookingsPaid: number;
    ticketsSold: number;
    grossPaise: string;
    refundedPaise: string;
    generatedAt: Date;
  }>(
    `SELECT to_char(report_date, 'YYYY-MM-DD') AS "reportDate", bookings_paid AS "bookingsPaid", tickets_sold AS "ticketsSold",
            gross_paise::text AS "grossPaise", refunded_paise::text AS "refundedPaise", generated_at AS "generatedAt"
       FROM reports WHERE organizer_id = $1 ORDER BY report_date DESC LIMIT 14`,
    [user.id],
  );
  return {
    events: events.rows.map((e) => ({
      ...e,
      startsAt: e.startsAt.toISOString(),
      grossPaise: Number(e.grossPaise),
      refundedPaise: Number(e.refundedPaise),
    })),
    daily: daily.rows.map((d) => ({
      ...d,
      grossPaise: Number(d.grossPaise),
      refundedPaise: Number(d.refundedPaise),
      generatedAt: d.generatedAt.toISOString(),
    })),
  };
}

export interface SalesDayDto {
  date: string;
  bookingsPaid: number;
  ticketsSold: number;
  grossPaise: number;
}

export interface TierSalesDto {
  tier: string;
  totalSeats: number;
  seatsSold: number;
  seatsHeld: number;
  grossPaise: number;
}

export interface RecentSaleDto {
  bookingId: string;
  eventId: string;
  eventTitle: string;
  seats: number;
  amountPaise: number;
  paidAt: string;
}

/**
 * Live analytics for the organizer dashboard: one row per UTC day for the last `days` days
 * (zero-filled, so the client can chart it directly), seat sales per tier, and the latest
 * settled payments. Admins see every organizer's events, matching getSalesSummary.
 */
export async function getSalesAnalytics(
  user: AuthUser,
  days: number,
): Promise<{ days: number; timeline: SalesDayDto[]; tiers: TierSalesDto[]; recent: RecentSaleDto[] }> {
  const scope = [user.id, user.role === 'admin'];
  const timeline = await pool.query<{ date: string; bookingsPaid: number; ticketsSold: number; grossPaise: string }>(
    `WITH sales AS (
       SELECT (p.succeeded_at AT TIME ZONE 'UTC')::date AS day, p.amount_paise,
              (SELECT count(*) FROM booking_seats bs WHERE bs.booking_id = b.id)::int AS seats
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN events e ON e.id = b.event_id
        WHERE p.succeeded_at IS NOT NULL
          AND p.succeeded_at >= (now() AT TIME ZONE 'UTC')::date - ($3::int - 1)
          AND ($2 OR e.organizer_id = $1)
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
            count(s.day)::int AS "bookingsPaid",
            COALESCE(sum(s.seats), 0)::int AS "ticketsSold",
            COALESCE(sum(s.amount_paise), 0)::text AS "grossPaise"
       FROM generate_series((now() AT TIME ZONE 'UTC')::date - ($3::int - 1), (now() AT TIME ZONE 'UTC')::date, interval '1 day') AS d(day)
       LEFT JOIN sales s ON s.day = d.day
      GROUP BY d.day
      ORDER BY d.day`,
    [...scope, days],
  );
  const tiers = await pool.query<{ tier: string; totalSeats: number; seatsSold: number; seatsHeld: number; grossPaise: string }>(
    `SELECT s.tier,
            count(*)::int AS "totalSeats",
            count(*) FILTER (WHERE b.status = 'PAID')::int AS "seatsSold",
            count(*) FILTER (WHERE b.status = 'HELD' AND b.hold_expires_at > now())::int AS "seatsHeld",
            COALESCE(sum(s.price_paise) FILTER (WHERE b.status = 'PAID'), 0)::text AS "grossPaise"
       FROM seats s
       JOIN events e ON e.id = s.event_id
       LEFT JOIN booking_seats bs ON bs.seat_id = s.id AND bs.is_active
       LEFT JOIN bookings b ON b.id = bs.booking_id
      WHERE $2 OR e.organizer_id = $1
      GROUP BY s.tier
      ORDER BY sum(s.price_paise) / count(*) DESC, s.tier`,
    scope,
  );
  const recent = await pool.query<{ bookingId: string; eventId: string; eventTitle: string; seats: number; amountPaise: number; paidAt: Date }>(
    `SELECT b.id AS "bookingId", e.id AS "eventId", e.title AS "eventTitle",
            (SELECT count(*) FROM booking_seats bs WHERE bs.booking_id = b.id)::int AS seats,
            p.amount_paise AS "amountPaise", p.succeeded_at AS "paidAt"
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN events e ON e.id = b.event_id
      WHERE p.succeeded_at IS NOT NULL AND ($2 OR e.organizer_id = $1)
      ORDER BY p.succeeded_at DESC
      LIMIT 8`,
    scope,
  );
  return {
    days,
    timeline: timeline.rows.map((d) => ({ ...d, grossPaise: Number(d.grossPaise) })),
    tiers: tiers.rows.map((t) => ({ ...t, grossPaise: Number(t.grossPaise) })),
    recent: recent.rows.map((r) => ({ ...r, paidAt: r.paidAt.toISOString() })),
  };
}
