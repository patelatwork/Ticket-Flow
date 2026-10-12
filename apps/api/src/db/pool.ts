import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_MS,
  idleTimeoutMillis: 30_000,
  application_name: 'ticketflow',
});

pool.on('error', (err) => {
  // Emitted for errors on idle clients (e.g. the server closed the connection).
  logger.error({ err }, 'postgres pool error');
});

export async function closePool(): Promise<void> {
  await pool.end();
}
