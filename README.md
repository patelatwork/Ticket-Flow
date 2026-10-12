# TicketFlow

A high-concurrency event-ticketing platform built around one guarantee: **correctness under
contention**. When a thousand people click the same seats at once, exactly one gets each
seat. Holds expire on time even if a process dies. A payment webhook delivered five times,
out of order or after the hold expired still settles exactly once, and the customer either
gets the seats or a refund. Postgres row locks with a global lock order, a partial unique
index, idempotency keys, and a transactional outbox feeding BullMQ enforce this. Concurrent
integration tests and a k6 stampede test prove it.

## Architecture

```mermaid
flowchart LR
  B[React SPA] --> N[nginx] --> A[API x N] --> PG[(Postgres)]
  A --> R[(Redis)]
  W[Worker: BullMQ + outbox relay + schedulers] --> PG & R
  W --> S[(MinIO)] & M[Mailpit]
```

- **API** (`apps/api/src/server.ts`) and **worker** (`src/worker.ts`) are separate entrypoints
  of one codebase and one image, so they scale independently.
- **Postgres** is the source of truth for every state change (each change is one transaction).
  **Redis** holds queues, cache, rate-limit counters and pub/sub, never anything that can't be
  rebuilt.
- Booking state machine: `HELD → PAID | EXPIRED | CANCELLED`, `PAID → REFUNDED`, all through
  one transition function. The single exception, `EXPIRED → PAID` for a late payment whose
  seats are still free, must be requested explicitly.
- Full design, diagrams and the failure-modes table: **[docs/architecture.md](docs/architecture.md)**.

## Run it

```bash
docker compose up --build
docker compose run --rm migrate node dist/src/db/seed.js     # demo users + 2 events x 100 seats
```

| URL | What |
|---|---|
| http://localhost:8080 | Web app |
| http://localhost:3000/docs | OpenAPI (Swagger UI), generated from the Zod schemas |
| http://localhost:8080/admin/queues | Bull Board (admin, see below) |
| http://localhost:8025 | Mailpit (ticket and refund emails) |
| http://localhost:9001 | MinIO console (`minioadmin` / `minioadmin`) |
| http://localhost:9100/metrics | Worker metrics (API: `:3000/metrics`) |

Seeded logins (password `Password123!`): `admin@`, `organizer@`, `attendee@ticketflow.dev`.

Optional: `docker compose --profile observability up -d` adds Prometheus (:9090) and
Grafana (:3001) with a provisioned TicketFlow dashboard.

**Bull Board:** sign in to the web app as `admin@ticketflow.dev` and click **Queues** in the
header. It trades your bearer token for a short-lived `/admin` cookie (`POST /admin/session`)
and opens `/admin/queues`.

**Payments:** the default `MockProvider` settles every order successfully ~2 s after "Pay".
To exercise the edge cases, set these on the `api` and `worker` services:
`MOCK_PAYMENT_DUPLICATES=3`, `MOCK_PAYMENT_OUT_OF_ORDER=true`,
`MOCK_PAYMENT_DROP_WEBHOOKS=true` (reconciliation fixes it within 5 + 10 min),
`MOCK_PAYMENT_OUTCOME=failure`. For Razorpay test mode, set `PAYMENT_PROVIDER=razorpay`
plus `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`, and point the
Razorpay webhook at `/webhooks/payments/razorpay`.

### Without Docker (development)
```bash
npm install
cp apps/api/.env.example apps/api/.env     # set JWT_ACCESS_SECRET
npm run db:local          # terminal 1: PostgreSQL 16 from npm binaries
# Redis 7, MinIO and Mailpit must be reachable (see .env), e.g. `docker compose up -d redis minio mailpit`
npm run migrate && npm run seed
npm run dev:api           # terminal 2: http://localhost:3000
npm run dev:worker        # terminal 3
npm run dev:web           # terminal 4: http://localhost:5173 (proxies /api)
```

## Scripts (repo root)
| Script | What it does |
|---|---|
| `npm test` | API integration tests. Starts a throwaway PostgreSQL 16 automatically (or uses `TEST_DATABASE_URL`). The BullMQ suite runs when `TEST_REDIS_URL` is set: `docker compose --profile test up -d postgres-test redis-test`, then `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/ticketflow_test TEST_REDIS_URL=redis://localhost:6380 npm test` |
| `npm run lint` / `npm run typecheck` | ESLint strict type-checked (API), `tsc` (API + web) |
| `npm run build` | Build API and web |
| `npm run migrate` / `npm run seed` | Apply migrations / idempotent demo seed |
| `npm run seed:loadtest -- …` | Fresh event + N users with pre-minted tokens for k6 |
| `npm run loadtest:verify -- --event <id>` | Post-run DB integrity check (exits 1 on any double booking) |

## API

Interactive docs at `/docs` (OpenAPI 3.1 at `/docs/openapi.json`). Summary:

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health/live`, `/health/ready` | – | readiness: Postgres (gating) + Redis (reported) |
| POST | `/auth/register` · `/auth/login` · `/auth/refresh` · `/auth/logout` | – / cookie | rate-limited; refresh rotation with reuse detection |
| GET | `/events` · `/events/:id` · `/events/:id/seats` | – | seat map cached in Redis |
| GET | `/events/:id/seats/stream` | – | **SSE**: snapshot, then live `seats` / `refresh` events |
| POST/PATCH/DELETE | `/events…`, `/events/:id/{publish,cancel,seats}` | organizer | cancel refunds paid bookings |
| POST | `/bookings` | bearer + `Idempotency-Key` | 201 HELD for 10 min · 409 `{seatIds}` · replay-safe |
| GET/POST | `/bookings`, `/bookings/:id`, `/bookings/:id/cancel` | owner | |
| POST / GET | `/bookings/:id/pay` · `/bookings/:id/payment` | owner | one in-flight order per booking |
| POST | `/webhooks/payments/:provider` | signature | `mock` or `razorpay`; deduped by event id |
| GET | `/tickets`, `/tickets/:id/download` | owner | presigned PDF URL (5 min) |
| POST | `/tickets/verify` | organizer of the event | check-in, exactly once |
| GET | `/organizer/sales` | organizer | live per-event sales + daily reports |
| GET/POST | `/admin/dlq`, `/admin/dlq/:id/retry`, `/admin/queues` | admin | dead letters, Bull Board |
| GET | `/metrics` | optional token | Prometheus |

## Load tests

```bash
# (a) 1,000 users vs 100 seats, all at once
JWT_ACCESS_TTL_SECONDS=3600 npm run seed:loadtest -- --seats 100 --users 1000 --out ../../load-tests/fixtures/contention.json
k6 run -e BASE_URL=http://localhost:3000 load-tests/contention.js
npm run loadtest:verify -- --event <eventId printed by the seed>

# (b) sustained hold -> pay -> webhook -> PAID (run api/worker with MOCK_PAYMENT_WEBHOOK_DELAY_MS=500)
JWT_ACCESS_TTL_SECONDS=3600 npm run seed:loadtest -- --seats 20000 --users 2000 --per-row 100 --out ../../load-tests/fixtures/flow.json
k6 run -e BASE_URL=http://localhost:3000 -e RATE=30 -e DURATION=3m load-tests/booking-flow.js
```

The seed script must use the same `DATABASE_URL` and `JWT_ACCESS_SECRET` as the API under
test. The contention script fails if any response is not 201/409 or if more seats are granted
than exist. `loadtest:verify` then checks the database directly: no seat in two active
bookings, `is_active` consistent with booking status, at most one successful payment per booking.

### Results

> Not recorded yet. Fill in after running the commands above, with the machine spec and the
> exact compose config used.

| Scenario | Throughput | p95 | p99 | Granted / conflicts | Double bookings (`loadtest:verify`) |
|---|---|---|---|---|---|
| (a) 1,000 VUs → 100 seats | – | – | – | – | – |
| (b) hold → pay → PAID @ 30/s, 3 min | – | – | – | time-to-PAID p95: – | – |

## Design trade-offs

- **Pessimistic locking over optimistic retries.** `SELECT … FOR UPDATE` in a global id order
  serializes contention on hot seats in the database with zero application retries, and
  losers get an immediate, precise 409 with the exact seat ids. Under extreme contention
  for a single seat this queues requests on one row lock. That is the right trade for a
  booking system, where correctness beats raw throughput on one seat.
- **Denormalized `is_active` + partial unique index** instead of an exclusion constraint or a
  trigger: B-tree speed, a named constraint, and every write visible in one function.
- **Transactional outbox** instead of enqueueing after commit: one more table and a relay,
  in exchange for "a job exists iff its state change committed". Delivery is at-least-once,
  so every handler is idempotent.
- **Late payments re-claim seats when possible** instead of always refunding. The customer
  gets what they paid for and a refund is avoided. A partially available group is refunded
  whole.
- **Best-effort real-time.** SSE updates and cache invalidation run after commit and may be
  lost if Redis hiccups. Clients resync by snapshot on reconnect, and the cache TTL bounds
  staleness. Correctness never depends on them.
- **Rate limits fail open** when Redis is down. Availability wins, because Postgres
  still protects every seat.
- **Mock gateway lives in Redis** (shared by API and worker) and is driven by a delayed job,
  so it behaves like a real asynchronous provider, misbehaviour included.
- **Emails are at-least-once.** SMTP can't join a transaction; a crash between send and mark
  can duplicate one email, and that is the documented trade.
