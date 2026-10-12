import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { transitionBooking } from './booking-state.js';
import { findBooking, type BookingStatus } from './bookings.repository.js';

export type HoldExpiryOutcome =
  | { result: 'expired' }
  /** Already PAID/CANCELLED/EXPIRED (or gone): nothing to do. Running twice lands here. */
  | { result: 'noop'; status: BookingStatus | 'MISSING' }
  /** Still HELD but not lapsed on the DB clock (job fired early): try again later. */
  | { result: 'not-due'; retryInMs: number };

/**
 * Handler logic for the delayed `hold-expiry` job. Idempotent: the guard re-checks the
 * locked row, so a duplicate or late job is a no-op, and an expiry that races a payment
 * serializes on the booking row lock. Whichever commits first wins, and the other sees
 * the new status.
 */
export async function expireHold(bookingId: string): Promise<HoldExpiryOutcome> {
  if (!(await findBooking(pool, bookingId))) return { result: 'noop', status: 'MISSING' };

  return withTransaction(async (tx): Promise<HoldExpiryOutcome> => {
    const outcome = await transitionBooking(tx, bookingId, 'EXPIRED', {
      guard: (b) => b.status === 'HELD' && b.holdLapsed,
    });
    if (outcome.applied) return { result: 'expired' };
    const { booking } = outcome;
    if (booking.status === 'HELD') {
      // Delay was computed from the DB clock at relay time, so this is rare; add a margin.
      return { result: 'not-due', retryInMs: Math.max(1_000, booking.holdExpiresAt.getTime() - Date.now() + 500) };
    }
    return { result: 'noop', status: booking.status };
  });
}

