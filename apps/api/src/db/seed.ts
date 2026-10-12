import bcrypt from 'bcrypt';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { Role } from '../modules/auth/tokens.js';
import { closePool } from './pool.js';
import { withTransaction, type TxClient } from './tx.js';

/** Development seed data. Safe to run repeatedly: existing rows are left untouched. */
const SEED_PASSWORD = 'Password123!';

const USERS: { email: string; role: Role }[] = [
  { email: 'admin@ticketflow.dev', role: 'admin' },
  { email: 'organizer@ticketflow.dev', role: 'organizer' },
  { email: 'attendee@ticketflow.dev', role: 'attendee' },
];

// 10 rows x 10 seats; price in paise.
const TIERS = [
  { rows: ['A', 'B'], tier: 'VIP', pricePaise: 500_000 },
  { rows: ['C', 'D', 'E', 'F'], tier: 'Gold', pricePaise: 250_000 },
  { rows: ['G', 'H', 'I', 'J'], tier: 'Silver', pricePaise: 100_000 },
];

async function upsertUser(tx: TxClient, email: string, role: Role, passwordHash: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email, passwordHash, role],
  );
  const row = rows[0];
  if (!row) throw new Error(`failed to upsert ${email}`);
  return row.id;
}

async function seedEvent(tx: TxClient, organizerId: string, title: string, daysFromNow: number): Promise<void> {
  const existing = await tx.query(`SELECT 1 FROM events WHERE organizer_id = $1 AND title = $2`, [organizerId, title]);
  if (existing.rowCount) return;

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO events (organizer_id, title, description, venue, starts_at, status)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), 'PUBLISHED') RETURNING id`,
    [organizerId, title, 'Seeded demo event.', 'Jawaharlal Nehru Stadium, Delhi', daysFromNow],
  );
  const eventId = rows[0]?.id;
  if (!eventId) throw new Error('failed to insert event');

  const seats = TIERS.flatMap(({ rows: seatRows, tier, pricePaise }) =>
    seatRows.flatMap((row) => Array.from({ length: 10 }, (_, i) => ({ label: `${row}${i + 1}`, tier, pricePaise }))),
  );
  await tx.query(
    `INSERT INTO seats (event_id, label, tier, price_paise)
     SELECT $1, t.label, t.tier, t.price FROM unnest($2::text[], $3::text[], $4::int[]) AS t(label, tier, price)`,
    [eventId, seats.map((s) => s.label), seats.map((s) => s.tier), seats.map((s) => s.pricePaise)],
  );
}

try {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, env.BCRYPT_ROUNDS);
  await withTransaction(async (tx) => {
    const ids = new Map<Role, string>();
    for (const u of USERS) ids.set(u.role, await upsertUser(tx, u.email, u.role, passwordHash));
    const organizerId = ids.get('organizer');
    if (!organizerId) throw new Error('organizer missing');
    await seedEvent(tx, organizerId, 'Indie Night Live', 14);
    await seedEvent(tx, organizerId, 'Stand-up Saturday', 30);
  });
  logger.info({ users: USERS.map((u) => u.email), password: SEED_PASSWORD }, 'seed complete');
} catch (err) {
  logger.error({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await closePool();
}
