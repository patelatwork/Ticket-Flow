import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/db/migrations-runner.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const address = srv.address();
      srv.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('could not allocate a port'));
      });
    });
  });
}

/**
 * Provides a migrated PostgreSQL 16 database for the integration suite.
 *  - TEST_DATABASE_URL set (CI / docker compose test profile): its public schema is wiped and re-migrated.
 *  - otherwise: a throwaway embedded PostgreSQL 16 server is started from npm binaries.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  let teardown = (): Promise<void> => Promise.resolve();

  if (databaseUrl) {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await client.end();
  } else {
    const port = await freePort();
    const databaseDir = mkdtempSync(join(tmpdir(), 'ticketflow-test-pg-'));
    const server = new EmbeddedPostgres({
      databaseDir,
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      // Durability is irrelevant for a throwaway test cluster; trade it for speed.
      postgresFlags: ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=200'],
      onLog: () => undefined,
    });
    await server.initialise();
    await server.start();
    await server.createDatabase('ticketflow_test');
    databaseUrl = `postgres://postgres:postgres@localhost:${port}/ticketflow_test`;
    teardown = async () => {
      await server.stop();
      rmSync(databaseDir, { recursive: true, force: true });
    };
  }

  await runMigrations(databaseUrl);
  project.provide('databaseUrl', databaseUrl);
  return teardown;
}
