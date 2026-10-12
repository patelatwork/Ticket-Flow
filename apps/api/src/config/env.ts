import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

// Load .env from the working directory without overriding variables that are
// already set (real environment and test setup win over the file).
if (process.env.NODE_ENV !== 'test' && existsSync('.env')) {
  const fromFile = parseEnv(readFileSync('.env', 'utf8'));
  for (const [key, value] of Object.entries(fromFile)) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}

const booleanString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanString.default(false),

  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: booleanString.optional(),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  HOLD_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.map(String).join('.')}: ${i.message}`);
    // The logger depends on config, so fail loudly on stderr instead.
    console.error(`Invalid environment configuration:\n${issues.join('\n')}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const cookieSecure = env.COOKIE_SECURE ?? isProduction;
