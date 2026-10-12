/**
 * Runs a real PostgreSQL 16 server from npm binaries (embedded-postgres) for local
 * development without Docker. Data persists in apps/api/.data/postgres.
 *
 *   npm run db:local        # keep running in its own terminal; Ctrl+C to stop
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const port = Number(process.env.LOCAL_PG_PORT ?? 5432);
const databaseDir = resolve('.data/postgres');
const database = 'ticketflow';

mkdirSync(resolve('.data'), { recursive: true });

const server = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => undefined,
});

let initialised = true;
try {
  await server.initialise();
} catch {
  // initialise() fails when the data directory already exists, which is expected on restarts.
  initialised = false;
}
await server.start();

const client = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${port}/postgres` });
await client.connect();
const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
if (!exists.rowCount) await client.query(`CREATE DATABASE ${database}`);
await client.end();

console.log(`PostgreSQL 16 ${initialised ? 'initialised and ' : ''}running on port ${port}`);
console.log(`DATABASE_URL=postgres://postgres:postgres@localhost:${port}/${database}`);
console.log('Press Ctrl+C to stop.');

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
