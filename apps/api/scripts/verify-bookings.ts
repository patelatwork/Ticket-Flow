/**
 * Post-load-test integrity check, straight against Postgres. Exits non-zero on any violation.
 *
 *   npm run loadtest:verify -- --event <eventId>
 *
 * Checks (independently of the unique index, by joining on booking status):
 *  1. no seat belongs to more than one HELD/PAID booking (double booking)
 *  2. booking_seats.is_active agrees with the booking status for every row
 *  3. active seats <= seats in the event
 *  4. no booking was settled by more than one successful payment
 */
import { parseArgs } from 'node:util';
import { closePool, pool } from '../src/db/pool.js';

const { values } = parseArgs({ options: { event: { type: 'string' } } });
const eventId = values.event;
if (!eventId) throw new Error('--event <id> is required');

const failures: string[] = [];
function report(name: string, violations: number, detail?: unknown): void {
  const ok = violations === 0;
  if (!ok) failures.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${violations} violation(s)`}`);
  if (!ok && detail) console.log(JSON.stringify(detail, null, 2));
}

try {
  const doubles = await pool.query<{ seatId: string; bookings: string[] }>(
    `SELECT bs.seat_id AS "seatId", array_agg(b.id) AS bookings
       FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
      WHERE bs.event_id = $1 AND b.status IN ('HELD', 'PAID')
      GROUP BY bs.seat_id HAVING count(*) > 1`,
    [eventId],
  );
  report('no seat in more than one active booking', doubles.rowCount ?? 0, doubles.rows.slice(0, 10));

  const drift = await pool.query(
    `SELECT bs.booking_id FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
      WHERE bs.event_id = $1 AND bs.is_active <> (b.status IN ('HELD', 'PAID'))`,
    [eventId],
  );
  report('is_active matches booking status', drift.rowCount ?? 0);

  const counts = await pool.query<{ seats: number; active: number; held: number; paid: number; total: number }>(
    `SELECT (SELECT count(*) FROM seats WHERE event_id = $1)::int AS seats,
            (SELECT count(*) FROM booking_seats WHERE event_id = $1 AND is_active)::int AS active,
            (SELECT count(*) FROM bookings WHERE event_id = $1 AND status = 'HELD')::int AS held,
            (SELECT count(*) FROM bookings WHERE event_id = $1 AND status = 'PAID')::int AS paid,
            (SELECT count(*) FROM bookings WHERE event_id = $1)::int AS total`,
    [eventId],
  );
  const c = counts.rows[0];
  if (!c) throw new Error('count query returned nothing');
  report('active seats <= event seats', c.active > c.seats ? c.active - c.seats : 0);

  const doublePaid = await pool.query(
    `SELECT p.booking_id FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE b.event_id = $1 AND p.status = 'SUCCEEDED'
      GROUP BY p.booking_id HAVING count(*) > 1`,
    [eventId],
  );
  report('at most one successful payment per booking', doublePaid.rowCount ?? 0);

  console.log(`\nseats=${c.seats} activeSeats=${c.active} bookings: total=${c.total} held=${c.held} paid=${c.paid}`);
} finally {
  await closePool();
}
process.exitCode = failures.length > 0 ? 1 : 0;
