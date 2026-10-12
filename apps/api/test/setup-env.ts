import { inject } from 'vitest';

// Runs before each test file's imports, so src/config/env.ts sees these values.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.DATABASE_POOL_MAX = '30';
// Opening many connections at once is slow on Windows (one process each); don't let fixtures flake.
process.env.DATABASE_CONNECT_TIMEOUT_MS = '30000';
process.env.JWT_ACCESS_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';
process.env.BCRYPT_ROUNDS = '4';
process.env.HOLD_TTL_SECONDS = '600';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
