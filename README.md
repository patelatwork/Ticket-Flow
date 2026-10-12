# TicketFlow

A high-concurrency event-ticketing platform built around one guarantee: **correctness under
contention**. Seats are never double-booked, jobs are never lost, and payments are never
applied twice. Postgres row locks with a global lock order, a partial unique index, and
idempotency keys enforce this. A suite of concurrent integration tests proves it.

> **Status:** Phase 1 of 6: foundation, auth, events/seats, synchronous booking.
> See [docs/architecture.md](docs/architecture.md) for the design.

## Stack
Node 20 · Express 5 · TypeScript (strict) · PostgreSQL 16 (raw SQL via `pg`, node-pg-migrate)
· Zod · pino · Vitest + Supertest. Coming next: Redis/BullMQ, MinIO, React.

## Running locally

### Option A: without Docker
```bash
npm install
cp apps/api/.env.example apps/api/.env   # then set JWT_ACCESS_SECRET
npm run db:local      # terminal 1: real PostgreSQL 16 from npm binaries, port 5432
npm run migrate       # terminal 2
npm run seed
npm run dev:api       # http://localhost:3000
```

### Option B: Docker
```bash
docker compose up --build    # postgres, redis, minio, migrations, api
docker compose run --rm migrate node dist/src/db/seed.js   # optional seed data
```

Seeded logins (password `Password123!`): `admin@`, `organizer@`, `attendee@ticketflow.dev`.

## Scripts (repo root)
| Script | What it does |
|---|---|
| `npm test` | Integration tests. Starts a throwaway PostgreSQL 16 automatically, or uses `TEST_DATABASE_URL` if set (e.g. `docker compose --profile test up -d postgres-test` → `postgres://postgres:postgres@localhost:5433/ticketflow_test`). |
| `npm run lint` | ESLint (typescript-eslint strict, type-checked) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | Apply SQL migrations (`npm run migrate -w @ticketflow/api -- down` reverts one) |
| `npm run seed` | Idempotent dev seed: 3 users, 2 events × 100 seats |

## API (Phase 1)
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health/live`, `/health/ready` | – | readiness pings Postgres |
| POST | `/auth/register` · `/auth/login` | – | returns `accessToken`; refresh token in httpOnly cookie |
| POST | `/auth/refresh` · `/auth/logout` | cookie | rotation with reuse detection |
| GET | `/auth/me` | bearer | |
| GET | `/events` · `/events/:id` · `/events/:id/seats` | – | public; seat map with `AVAILABLE/HELD/SOLD` |
| GET | `/events/mine` | organizer | |
| POST/PATCH | `/events`, `/events/:id`, `/events/:id/publish`, `/events/:id/cancel` | organizer (owner) / admin | |
| POST/DELETE | `/events/:id/seats`, `/events/:id/seats/:seatId` | organizer (owner) / admin | bulk add up to 1000 |
| POST | `/bookings` | bearer + `Idempotency-Key` | 201 HELD for 10 min · 409 `{seatIds}` · replay returns the original response |
| GET | `/bookings`, `/bookings/:id` | bearer (owner) | |
| POST | `/bookings/:id/cancel` | bearer (owner) | HELD → CANCELLED |

OpenAPI docs at `/docs` arrive in Phase 6.

## Design notes
- **One active booking per seat:** `booking_seats.is_active` plus a unique partial index,
  kept in sync by the single state-transition function ([why](docs/architecture.md#the-core-invariant-one-active-booking-per-seat)).
- **Deadlock-free:** seats are always locked in ascending id order.
- **Idempotency:** per-user keys whose claim is serialized by Postgres itself. Committed
  outcomes (201 and 409) are stored and replayed.
