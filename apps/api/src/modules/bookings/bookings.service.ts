import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { withTransaction, type Queryable, type TxClient } from '../../db/tx.js';
import { sha256Hex } from '../../lib/crypto.js';
import { AppError, type ErrorBody } from '../../lib/errors.js';
import type { HttpResult } from '../../lib/http.js';
import { jobId } from '../../queues/definitions.js';
import { addToOutbox } from '../../queues/outbox.js';
import type { AuthUser } from '../auth/tokens.js';
import { lockEvent } from '../events/events.repository.js';
import * as idempotency from '../idempotency/idempotency.repository.js';
import { publishSeatStatesAfterCommit } from '../live/seat-events.js';
import { transitionBooking } from './booking-state.js';
import * as repo from './bookings.repository.js';
import type { CreateBookingBody } from './bookings.schemas.js';

export interface BookingSeatDto {
  id: string;
  label: string;
  tier: string;
  pricePaise: number;
}

export interface BookingDto {
  id: string;
  eventId: string;
  eventTitle: string;
  eventStartsAt: string;
  status: repo.BookingStatus;
  holdExpiresAt: string;
  totalPaise: number;
  createdAt: string;
  seats: BookingSeatDto[];
}

function toBookingDto(b: repo.BookingDetailsRow): BookingDto {
  return {
    id: b.id,
    eventId: b.eventId,
    eventTitle: b.eventTitle,
    eventStartsAt: b.eventStartsAt.toISOString(),
    status: b.status,
    holdExpiresAt: b.holdExpiresAt.toISOString(),
    totalPaise: b.totalPaise,
    createdAt: b.createdAt.toISOString(),
    seats: b.seats,
  };
}

async function loadBookingDto(db: Queryable, id: string): Promise<BookingDto> {
  const details = await repo.findBookingDetails(db, id);
  if (!details) throw AppError.notFound('Booking');
  return toBookingDto(details);
}

export type CreateBookingResult = HttpResult<{ booking: BookingDto } | ErrorBody>;

/**
 * Creates a HELD booking for the requested seats, in ONE transaction:
 *
 *  1. Claim the idempotency key (a concurrent duplicate blocks here, then replays).
 *  2. FOR SHARE the event: it cannot be cancelled while we book.
 *  3. FOR UPDATE the seats in ascending id order (deadlock-free).
 *  4. Lazily expire lapsed holds on those seats; anything still active is a conflict.
 *  5. Insert the booking + booking_seats (the partial unique index is the final backstop).
 *  6. Write the hold-expiry job to the outbox (delayed until hold_expires_at).
 *  7. Store the response under the idempotency key.
 *
 * A 409 for unavailable seats is a *committed* outcome, stored and replayed like a 201.
 * Validation-type errors (unknown event/seats) roll back, so the key can be retried.
 */
export async function createBooking(user: AuthUser, idempotencyKey: string, input: CreateBookingBody): Promise<CreateBookingResult> {
  const seatIds = [...input.seatIds].sort();
  const requestHash = sha256Hex(JSON.stringify({ op: 'POST /bookings', eventId: input.eventId, seatIds }));

  return withTransaction(async (tx): Promise<CreateBookingResult> => {
    const claim = await idempotency.claimKey(tx, user.id, idempotencyKey, requestHash);
    if (claim.kind === 'existing') {
      if (claim.requestHash !== requestHash) {
        throw AppError.unprocessable('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
      }
      if (claim.statusCode === null) {
        // Unreachable: a key is claimed and completed in the same transaction.
        throw AppError.conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is in progress');
      }
      return { status: claim.statusCode, body: claim.body as CreateBookingResult['body'], replayed: true };
    }

    const result = await reserveSeats(tx, user.id, idempotencyKey, input.eventId, seatIds);
    await idempotency.saveResponse(tx, user.id, idempotencyKey, result.status, result.body);
    return result;
  });
}

async function reserveSeats(
  tx: TxClient,
  userId: string,
  idempotencyKey: string,
  eventId: string,
  seatIds: string[],
): Promise<CreateBookingResult> {
  const event = await lockEvent(tx, eventId, 'share');
  if (!event || event.status !== 'PUBLISHED') throw AppError.notFound('Event');
  if (event.startsAt.getTime() <= Date.now()) throw AppError.conflict('EVENT_STARTED', 'Event has already started');

  const seats = await repo.lockSeatsInOrder(tx, eventId, seatIds);
  if (seats.length !== seatIds.length) {
    const found = new Set(seats.map((s) => s.id));
    throw AppError.unprocessable('SEATS_NOT_FOUND', 'Some seats do not belong to this event', {
      seatIds: seatIds.filter((id) => !found.has(id)),
    });
  }

  const claims = await repo.findActiveClaims(tx, eventId, seatIds);
  const freed = await expireLapsedHolds(tx, claims);
  const unavailable = claims.filter((c) => !freed.has(c.bookingId)).map((c) => c.seatId).sort();
  if (unavailable.length > 0) {
    return {
      status: 409,
      replayed: false,
      body: {
        error: { code: 'SEATS_UNAVAILABLE', message: 'Some seats are no longer available', details: { seatIds: unavailable } },
      },
    };
  }

  const booking = await repo.insertHeldBooking(tx, {
    userId,
    eventId,
    idempotencyKey,
    totalPaise: seats.reduce((sum, s) => sum + s.pricePaise, 0),
    holdSeconds: env.HOLD_TTL_SECONDS,
  });
  await repo.insertBookingSeats(tx, booking.id, eventId, seatIds);
  // Same transaction as the booking: the expiry job exists iff the hold does.
  await addToOutbox(tx, 'hold-expiry', { bookingId: booking.id }, { jobId: jobId('hold-expiry', booking.id), runAt: booking.holdExpiresAt });
  publishSeatStatesAfterCommit(tx, eventId, seatIds.map((id) => ({ id, state: 'HELD' as const })));
  return { status: 201, replayed: false, body: { booking: await loadBookingDto(tx, booking.id) } };
}

/**
 * Expires HELD bookings whose hold has lapsed but which the expiry job has not processed
 * yet, so an overdue job can never keep a seat unsellable. Booking rows are locked in
 * ascending id order; the guard makes this a no-op if someone else already moved them.
 */
async function expireLapsedHolds(tx: TxClient, claims: repo.ActiveSeatClaim[]): Promise<Set<string>> {
  const candidates = [...new Set(claims.filter((c) => c.status === 'HELD' && c.holdLapsed).map((c) => c.bookingId))].sort();
  const freed = new Set<string>();
  for (const bookingId of candidates) {
    const result = await transitionBooking(tx, bookingId, 'EXPIRED', {
      guard: (b) => b.status === 'HELD' && b.holdLapsed,
    });
    // Whether we expired it or another transaction did, it no longer holds the seats.
    if (result.applied || result.booking.status !== 'HELD') freed.add(bookingId);
  }
  return freed;
}

export async function getBooking(user: AuthUser, id: string): Promise<BookingDto> {
  const details = await repo.findBookingDetails(pool, id);
  if (!details || (details.userId !== user.id && user.role !== 'admin')) throw AppError.notFound('Booking');
  return toBookingDto(details);
}

export async function listMyBookings(user: AuthUser): Promise<BookingDto[]> {
  const rows = await repo.listBookingDetailsForUser(pool, user.id);
  return rows.map(toBookingDto);
}

export async function cancelBooking(user: AuthUser, id: string): Promise<BookingDto> {
  return withTransaction(async (tx) => {
    const booking = await repo.findBooking(tx, id);
    if (!booking || booking.userId !== user.id) throw AppError.notFound('Booking');
    await transitionBooking(tx, id, 'CANCELLED');
    return loadBookingDto(tx, id);
  });
}
