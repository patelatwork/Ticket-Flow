# TicketFlow architecture

> Status: Phase 1 (foundation + synchronous booking). Component and sequence diagrams and
> the full failure-modes table are added in Phase 6.

## Layers

Each module under `apps/api/src/modules/<name>` follows the same structure:

| Layer | File | Responsibility |
|---|---|---|
| Route | `*.routes.ts` | Parse input with Zod, call one service function, shape the HTTP response. No business logic. |
| Service | `*.service.ts` | Business rules, authorization, transaction boundaries. |
| Repository | `*.repository.ts` | Raw SQL only. Functions that need row locks take a `TxClient`. |

`TxClient` is a branded type that only `withTransaction()` can produce. A function that
requires a `TxClient` (lock helpers, the booking state machine) therefore *cannot* be called
outside a transaction. The compiler enforces this rule; it does not rely on convention.

## The core invariant: one active booking per seat

**Rule:** a seat may belong to at most one booking whose status is `HELD` or `PAID`.
History (expired, cancelled, refunded bookings) must stay in `booking_seats`.

### Approach chosen: denormalized `is_active` + partial unique index

```sql
CREATE UNIQUE INDEX booking_seats_one_active_per_seat
  ON booking_seats (event_id, seat_id)
  WHERE is_active;
```

`booking_seats.is_active` mirrors `bookings.status IN ('HELD','PAID')`. Only one function
writes it: `transitionBooking()` (`modules/bookings/booking-state.ts`). That function runs
in the same transaction as the status change, so the two values can never be observed out of
sync. New bookings insert their `booking_seats` rows with `is_active = true`.

**Why not reference `bookings.status` directly?** A partial index predicate can only use
columns of its own table.

**Why not an exclusion constraint?** `EXCLUDE USING gist (seat_id WITH =) WHERE (is_active)`
would also work, but it needs the `btree_gist` extension, and it is a GiST index doing what a
plain B-tree unique index does faster. With no ranges or overlaps involved, a unique partial
index is the simpler and faster tool. It also gives us a named constraint
(`23505` on `booking_seats_one_active_per_seat`) that is easy to assert on in tests.

**Why not a trigger that syncs `is_active` from `bookings.status`?** It would be equally
correct, but it hides a write that matters. Keeping it in the single transition function
keeps every state change explicit and testable in one place.

The index is the **backstop**. The normal path never reaches it, because seats are locked
and checked first (below). A raw SQL insert that bypasses the service is still rejected
(see `booking-state.test.ts`).

## `POST /bookings`: one transaction

```
BEGIN
 1. INSERT idempotency_keys (user_id, key, request_hash) ON CONFLICT DO NOTHING
      -> conflict: return the stored response (422 if the request hash differs)
 2. SELECT event ... FOR SHARE                    -- event can't be cancelled under us
 3. SELECT seats WHERE id = ANY($ids) ORDER BY id FOR UPDATE
 4. SELECT active booking_seats for those seats
      -> lapsed HELD holds: transitionBooking(EXPIRED) (lazy expiry)
      -> anything still active: 409 SEATS_UNAVAILABLE {seatIds}
 5. INSERT bookings (HELD, hold_expires_at = now() + 10 min)
    INSERT booking_seats (is_active = true)
 6. UPDATE idempotency_keys SET status_code, response_body
COMMIT
```

### Deadlock freedom
Every transaction that locks seats locks them **in ascending `seat.id` order**, whatever
order the client sent. In the plan, `LockRows` sits above `Sort`, so `ORDER BY id FOR UPDATE`
acquires the locks in that order. When all lockers share one global order, no wait-for cycle
can form. Booking rows touched by lazy expiry are also locked in ascending id order, and
always *after* seat locks. Nothing locks seats after it has locked a booking.

`booking-concurrency.test.ts` runs overlapping multi-seat requests in forward, reversed and
shuffled orders. It asserts there are no 5xx responses (a deadlock would surface as
`503 RETRYABLE_CONFLICT`). A control test shows that the same seats locked in opposite order
*without* the global order really do deadlock.

### Idempotency
- Keys are scoped per user: primary key `(user_id, key)`.
- The request hash covers the operation, the event and the **sorted** seat ids, so the same
  seats in a different order count as the same request. Reusing a key with a different
  request returns `422 IDEMPOTENCY_KEY_REUSED`.
- **Concurrent duplicates:** the second `INSERT` blocks on the first transaction's
  uncommitted key. After that transaction commits, the second one reads the stored response.
  If it rolled back, the second one proceeds as the original. Postgres serializes the
  duplicates for us, with no application-level lock.
- **What is stored:** committed outcomes. Those are `201` and `409 SEATS_UNAVAILABLE`, so a
  retried 409 replays as 409 even if the seat has since been freed. A new attempt needs a new
  key. Validation-type failures (unknown event, seats from another event) roll back the whole
  transaction, the key included, so the client can fix the request and retry with the same key.

### Lazy expiry
A `HELD` booking past `hold_expires_at` still owns its seats until something expires it.
Phase 2 adds the delayed `hold-expiry` job. The booking path also expires lapsed holds it
runs into (step 4), so a late or failed expiry job can never keep a seat unsellable.
For the same reason, the public seat map reports lapsed holds as `AVAILABLE`.
Timestamps are compared with Postgres `now()`, never the app clock, so clock skew between
the app and the DB cannot affect the result.

## Booking state machine

```
HELD -> PAID | EXPIRED | CANCELLED
PAID -> REFUNDED
```

`transitionBooking(tx, id, to, { guard? })` does the following:
1. locks the booking (`FOR UPDATE`);
2. if a `guard` is given and returns false, returns `{ applied: false }` without error.
   Idempotent callers such as expiry use this to mean "only if it is still HELD and lapsed";
3. otherwise validates the transition and throws `IllegalTransitionError` (HTTP 409) if it
   is not allowed;
4. updates the status and syncs `booking_seats.is_active`.

## Auth
- Access tokens: HS256 JWTs (15 min), sent as `Authorization: Bearer`.
- Refresh tokens: 32 random bytes, stored as SHA-256 hashes, sent in an
  `httpOnly; SameSite=Strict` cookie scoped to `/auth`. Every refresh rotates the token.
  Presenting an already-rotated token is treated as theft and revokes the whole token
  family (every session derived from that login).
- Login compares against a dummy bcrypt hash for unknown emails, so response timing does not
  reveal whether an account exists.
- RBAC: `requireRole('organizer', 'admin')`. Ownership checks (an organizer may only manage
  their own events) live in services.

## Conventions
- Money is integer paise (`integer` columns, `z.number().int()`).
- All timestamps are `timestamptz`, serialized as ISO-8601 UTC.
- Error body: `{ error: { code, message, details?, requestId } }`. The request id is also
  returned in the `x-request-id` header and appears on every log line.
