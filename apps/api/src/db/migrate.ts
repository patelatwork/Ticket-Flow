import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { runMigrations } from './migrations-runner.js';

const direction = process.argv[2] === 'down' ? 'down' : 'up';

try {
  const applied = await runMigrations(env.DATABASE_URL, direction, (msg) => {
    logger.debug(msg);
  });
  logger.info({ direction, applied }, applied.length ? 'migrations applied' : 'no migrations to apply');
} catch (err) {
  logger.error({ err }, 'migration failed');
  process.exitCode = 1;
}
