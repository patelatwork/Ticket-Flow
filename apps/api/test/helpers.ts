import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { closePool, pool } from '../src/db/pool.js';
import { signAccessToken, type Role } from '../src/modules/auth/tokens.js';

export interface TestUser {
  id: string;
  email: string;
  role: Role;
  token: string;
  auth: { Authorization: string };
}

/**
 * Starts one real HTTP server per test file (shared by all requests, like production)
 * and truncates all tables before each test.
 */
export function useTestServer(): { url: () => string } {
  let server: Server | undefined;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      server.closeAllConnections();
    });
    await closePool();
  });

  return {
    url: () => {
      if (!server) throw new Error('server not started');
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
  };
}

export async function resetDb(): Promise<void> {
  await pool.query(
    `TRUNCATE idempotency_keys, booking_seats, bookings, seats, events, refresh_tokens, users RESTART IDENTITY CASCADE`,
  );
}

/** Inserts a user directly (skipping bcrypt) and mints an access token. */
export async function createUser(role: Role = 'attendee'): Promise<TestUser> {
  const [user] = await createUsers(1, role);
  if (!user) throw new Error('createUser failed');
  return user;
}

/** Bulk version in ONE statement, so fixtures don't open a burst of DB connections. */
export async function createUsers(count: number, role: Role = 'attendee'): Promise<TestUser[]> {
  const emails = Array.from({ length: count }, () => `${role}-${randomUUID()}@test.dev`);
  const { rows } = await pool.query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash, role)
     SELECT email, 'not-a-real-hash', $2 FROM unnest($1::text[]) AS email
     RETURNING id, email`,
    [emails, role],
  );
  return rows.map(({ id, email }) => {
    const token = signAccessToken({ id, role });
    return { id, email, role, token, auth: { Authorization: `Bearer ${token}` } };
  });
}

export interface TestEvent {
  eventId: string;
  organizer: TestUser;
  seatIds: string[];
  /** seatIds keyed by label, e.g. seats.get('A1') */
  seats: Map<string, string>;
}

/** Creates a PUBLISHED event with `seatCount` seats priced 1000 paise each (labels S1..Sn). */
export async function createPublishedEvent(seatCount: number, organizer?: TestUser): Promise<TestEvent> {
  const owner = organizer ?? (await createUser('organizer'));
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO events (organizer_id, title, venue, starts_at, status)
     VALUES ($1, 'Test Event', 'Test Venue', now() + interval '7 days', 'PUBLISHED') RETURNING id`,
    [owner.id],
  );
  const eventId = rows[0]?.id;
  if (!eventId) throw new Error('createPublishedEvent failed');
  const labels = Array.from({ length: seatCount }, (_, i) => `S${i + 1}`);
  const seatRows = await pool.query<{ id: string; label: string }>(
    `INSERT INTO seats (event_id, label, tier, price_paise)
     SELECT $1, label, 'Standard', 1000 FROM unnest($2::text[]) AS label
     RETURNING id, label`,
    [eventId, labels],
  );
  const seats = new Map(seatRows.rows.map((r) => [r.label, r.id]));
  return { eventId, organizer: owner, seatIds: labels.map((l) => seats.get(l) ?? ''), seats };
}

export function idemKey(): string {
  return `test-${randomUUID()}`;
}

export async function activeSeatCount(eventId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM booking_seats WHERE event_id = $1 AND is_active`,
    [eventId],
  );
  return rows[0]?.n ?? 0;
}

export function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}
