/**
 * Prepares a load test: one PUBLISHED event with N seats and M users with pre-minted access
 * tokens, written to a fixtures file the k6 scripts read. Tokens are minted directly so the
 * test measures booking/payment, not bcrypt and the auth rate limiter.
 *
 *   npm run seed:loadtest -- --seats 100 --users 1000 --out ../../load-tests/fixtures/contention.json
 *
 * Uses DATABASE_URL and JWT_ACCESS_SECRET (must match the API under test). Set
 * JWT_ACCESS_TTL_SECONDS high enough to outlast the run (e.g. 3600).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { closePool, pool } from '../src/db/pool.js';
import { signAccessToken } from '../src/modules/auth/tokens.js';

const { values } = parseArgs({
  options: {
    seats: { type: 'string', default: '100' },
    users: { type: 'string', default: '1000' },
    'per-row': { type: 'string', default: '25' },
    out: { type: 'string', default: '../../load-tests/fixtures/contention.json' },
  },
});
const seatCount = Number(values.seats);
const userCount = Number(values.users);
const perRow = Number(values['per-row']);
if (![seatCount, userCount, perRow].every((n) => Number.isInteger(n) && n > 0)) throw new Error('--seats, --users and --per-row must be positive integers');

const run = randomUUID().slice(0, 8);
try {
  const organizer = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'load-test-no-login', 'organizer') RETURNING id`,
    [`loadtest-organizer-${run}@ticketflow.dev`],
  );
  const organizerId = organizer.rows[0]?.id;
  if (!organizerId) throw new Error('organizer insert failed');

  const event = await pool.query<{ id: string }>(
    `INSERT INTO events (organizer_id, title, venue, starts_at, status)
     VALUES ($1, $2, 'Load Test Arena', now() + interval '30 days', 'PUBLISHED') RETURNING id`,
    [organizerId, `Load test ${run}`],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error('event insert failed');

  const labels = Array.from({ length: seatCount }, (_, i) => {
    const row = Math.floor(i / perRow);
    // A..Z, then AA, AB, ... (spreadsheet-style) so labels stay unique and sortable.
    const letter = (n: number): string => String.fromCharCode(65 + n);
    const rowName = row < 26 ? letter(row) : letter(Math.floor(row / 26) - 1) + letter(row % 26);
    return `${rowName}${(i % perRow) + 1}`;
  });
  const seats = await pool.query<{ id: string }>(
    `INSERT INTO seats (event_id, label, tier, price_paise)
     SELECT $1, label, 'Standard', 50000 FROM unnest($2::text[]) AS label RETURNING id`,
    [eventId, labels],
  );

  const emails = Array.from({ length: userCount }, (_, i) => `loadtest-${run}-${i}@ticketflow.dev`);
  const users = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role)
     SELECT email, 'load-test-no-login', 'attendee' FROM unnest($1::text[]) AS email RETURNING id`,
    [emails],
  );

  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({
      run,
      eventId,
      seatIds: seats.rows.map((r) => r.id),
      tokens: users.rows.map((u) => signAccessToken({ id: u.id, role: 'attendee' })),
    }),
  );
  console.log(`event ${eventId}: ${seatCount} seats, ${userCount} users -> ${out}`);
} finally {
  await closePool();
}
