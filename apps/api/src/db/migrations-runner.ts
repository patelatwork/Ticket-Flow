import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** Walk up from this file to the package root's migrations/ (works from src/ and dist/src/). */
function findMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('migrations directory not found');
    dir = parent;
  }
}

export type MigrationDirection = 'up' | 'down';

/** Deliberately free of app config so tests and tooling can call it with any URL. */
export async function runMigrations(
  databaseUrl: string,
  direction: MigrationDirection = 'up',
  log: (msg: string) => void = () => undefined,
): Promise<string[]> {
  const applied = await runner({
    databaseUrl,
    dir: findMigrationsDir(),
    direction,
    count: direction === 'up' ? Infinity : 1,
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    log,
  });
  return applied.map((m) => m.name);
}
