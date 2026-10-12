import type { TxClient } from '../../db/tx.js';
import { AppError } from '../../lib/errors.js';
import { lockBooking, setBookingSeatsActive, updateBookingStatus, type BookingRecord, type BookingStatus } from './bookings.repository.js';

/** Statuses in which a booking owns its seats (enforced by booking_seats.is_active). */
export const ACTIVE_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>(['HELD', 'PAID']);

const TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  HELD: ['PAID', 'EXPIRED', 'CANCELLED'],
  PAID: ['REFUNDED'],
  EXPIRED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends AppError {
  constructor(
    readonly bookingId: string,
    readonly from: BookingStatus,
    readonly to: BookingStatus,
  ) {
    super(409, 'ILLEGAL_TRANSITION', `Booking cannot move from ${from} to ${to}`, { bookingId, from, to });
    this.name = 'IllegalTransitionError';
  }
}

export type TransitionResult =
  | { applied: true; from: BookingStatus; booking: BookingRecord }
  | { applied: false; booking: BookingRecord };

export interface TransitionOptions {
  /**
   * Evaluated against the locked row. Returning false skips the transition without
   * error. This is how idempotent callers (e.g. expiry) say "only if still HELD and lapsed".
   */
  guard?: (booking: BookingRecord) => boolean;
}

/**
 * The single entry point for every booking status change.
 *
 * Requires a TxClient, so it always runs inside the caller's transaction. It row-locks the
 * booking, validates the transition against the state machine (throwing
 * IllegalTransitionError otherwise), updates the status and syncs booking_seats.is_active
 * in the same transaction.
 */
export async function transitionBooking(
  tx: TxClient,
  bookingId: string,
  to: BookingStatus,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  const booking = await lockBooking(tx, bookingId);
  if (!booking) throw AppError.notFound('Booking');
  if (options.guard && !options.guard(booking)) return { applied: false, booking };
  if (!canTransition(booking.status, to)) throw new IllegalTransitionError(bookingId, booking.status, to);

  const updated = await updateBookingStatus(tx, bookingId, to);
  await setBookingSeatsActive(tx, bookingId, ACTIVE_STATUSES.has(to));
  return { applied: true, from: booking.status, booking: updated };
}
