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

  // ---- Redis / queues (Phase 2) ----
  REDIS_URL: z.url().default('redis://localhost:6379'),
  QUEUE_PREFIX: z.string().min(1).default('tf'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  /** A claimed-but-not-dispatched outbox row becomes claimable again after this lease. */
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9100),

  // ---- Payments (Phase 3) ----
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  /** Where the MockProvider delivers its webhooks (the API's own base URL). */
  API_BASE_URL: z.url().default('http://localhost:3000'),
  MOCK_WEBHOOK_SECRET: z.string().min(16).default('mock-webhook-secret-change-me'),
  MOCK_PAYMENT_WEBHOOK_DELAY_MS: z.coerce.number().int().min(0).max(600_000).default(2_000),
  MOCK_PAYMENT_OUTCOME: z.enum(['success', 'failure']).default('success'),
  /** Extra copies of each webhook the mock sends (tests duplicate delivery). */
  MOCK_PAYMENT_DUPLICATES: z.coerce.number().int().min(0).max(10).default(0),
  /** Send a stale `payment.failed` after the `payment.captured` (tests out-of-order delivery). */
  MOCK_PAYMENT_OUT_OF_ORDER: booleanString.default(false),
  /** Never deliver the webhook (tests reconciliation). */
  MOCK_PAYMENT_DROP_WEBHOOKS: booleanString.default(false),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RECONCILE_PENDING_AFTER_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  /** A payment still unresolved at the provider after this long is marked FAILED. */
  PAYMENT_ABANDON_AFTER_MINUTES: z.coerce.number().int().min(5).max(10_080).default(120),

  // ---- Tickets / notifications (Phase 4) ----
  TICKET_QR_SECRET: z.string().min(32).default('dev-only-qr-secret-change-me-0123456789abcdef'),
  S3_ENDPOINT: z.url().default('http://localhost:9000'),
  /** Endpoint baked into presigned URLs; must be reachable from the user's browser. */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('tickets'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  TICKET_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  EMAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  EMAIL_FROM: z.string().default('TicketFlow <tickets@ticketflow.dev>'),
  WEB_BASE_URL: z.url().default('http://localhost:5173'),

  // ---- Hardening (Phase 6) ----
  RATE_LIMIT_ENABLED: booleanString.default(true),
  SEAT_MAP_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(15),
  /** When set, GET /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().min(16).optional(),
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

if (isProduction) {
  // Refuse to start production with the development defaults for secrets.
  const weak = (['MOCK_WEBHOOK_SECRET', 'TICKET_QR_SECRET'] as const).filter((k) => env[k].includes('change-me'));
  if (weak.length > 0 && process.env.ALLOW_DEV_SECRETS !== 'true') {
    console.error(`Refusing to start in production with default secrets: ${weak.join(', ')} (set ALLOW_DEV_SECRETS=true for local demos)`);
    process.exit(1);
  }
}
if (env.PAYMENT_PROVIDER === 'razorpay' && !(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET)) {
  console.error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET');
  process.exit(1);
}
