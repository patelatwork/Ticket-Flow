import type { IncomingHttpHeaders } from 'node:http';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { withTransaction, type TxClient } from '../../db/tx.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { jobId } from '../../queues/definitions.js';
import { addToOutbox } from '../../queues/outbox.js';
import type { AuthUser } from '../auth/tokens.js';
import { transitionBooking } from '../bookings/booking-state.js';
import * as bookingsRepo from '../bookings/bookings.repository.js';
import { lockEvent } from '../events/events.repository.js';
import * as repo from './payments.repository.js';
import { activePaymentProvider, getPaymentProvider, isProviderName } from './providers/registry.js';
import { InvalidWebhookError, type PaymentEvent, type ProviderName } from './providers/types.js';

export interface PaymentDto {
  id: string;
  bookingId: string;
  provider: string;
  status: repo.PaymentStatus;
  amountPaise: number;
  currency: string;
  providerOrderId: string | null;
  checkout: Record<string, unknown> | null;
  refundReason: string | null;
  createdAt: string;
}

export function toPaymentDto(p: repo.PaymentRecord): PaymentDto {
  return {
    id: p.id,
    bookingId: p.bookingId,
    provider: p.provider,
    status: p.status,
    amountPaise: p.amountPaise,
    currency: p.currency,
    providerOrderId: p.providerOrderId,
    checkout: p.checkout,
    refundReason: p.refundReason,
    createdAt: p.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------
// Starting a payment
// ---------------------------------------------------------------------------------------

/**
 * POST /bookings/:id/pay. Naturally idempotent: a booking has at most one PENDING payment
 * (partial unique index), and repeated calls return it.
 *
 * The provider call happens BETWEEN two short transactions, never inside one:
 *   tx1: lock booking, validate, insert PENDING payment (or reuse the pending one)
 *   ---  provider.createOrder()  (network)
 *   tx2: store the order id, guarded on it still being empty
 * A crash between leaves a PENDING payment without an order. The next "pay" call retries
 * the order creation, and reconciliation fails it if nobody does.
 */
export async function startPayment(user: AuthUser, bookingId: string): Promise<PaymentDto> {
  const payment = await withTransaction(async (tx) => {
    const booking = await bookingsRepo.lockBooking(tx, bookingId);
    if (!booking || booking.userId !== user.id) throw AppError.notFound('Booking');
    const pending = await repo.findPendingPaymentForBooking(tx, bookingId);
    if (pending) return pending;
    if (booking.status !== 'HELD') {
      throw AppError.conflict('BOOKING_NOT_PAYABLE', `Booking is ${booking.status}`, { status: booking.status });
    }
    if (booking.holdLapsed) throw AppError.conflict('HOLD_EXPIRED', 'The seat hold has expired');
    return repo.insertPayment(tx, { bookingId, provider: activePaymentProvider().name, amountPaise: booking.totalPaise });
  });
  if (payment.providerOrderId) return toPaymentDto(payment);

  const provider = getPaymentProvider(providerNameOf(payment.provider));
  const order = await provider.createOrder({ paymentId: payment.id, bookingId, amountPaise: payment.amountPaise });
  const stored = (await repo.setPaymentOrder(pool, payment.id, order.orderId, order.checkout)) ?? (await repo.findPaymentById(pool, payment.id));
  if (!stored) throw new Error(`payment ${payment.id} vanished`);
  return toPaymentDto(stored);
}

export async function getLatestPayment(user: AuthUser, bookingId: string): Promise<PaymentDto | null> {
  const booking = await bookingsRepo.findBooking(pool, bookingId);
  if (!booking || (booking.userId !== user.id && user.role !== 'admin')) throw AppError.notFound('Booking');
  const payment = await repo.latestPaymentForBooking(pool, bookingId);
  return payment ? toPaymentDto(payment) : null;
}

function providerNameOf(name: string): ProviderName {
  if (!isProviderName(name)) throw new Error(`unknown provider "${name}" on payment`);
  return name;
}

// ---------------------------------------------------------------------------------------
// Applying an outcome (webhook or reconciliation)
// ---------------------------------------------------------------------------------------

export type ApplyResult =
  | 'duplicate' // this event id was already applied
  | 'already-settled' // payment no longer pending (e.g. a stale "failed" after "captured")
  | 'paid' // HELD -> PAID
  | 'reclaimed' // late payment, seats still free: EXPIRED -> PAID
  | 'refund' // money captured but booking can't take it: refund queued
  | 'failed'; // payment marked FAILED; booking keeps its hold

export class UnknownOrderError extends Error {
  constructor(readonly orderId: string) {
    super(`no payment for order ${orderId}`);
    this.name = 'UnknownOrderError';
  }
}

/**
 * Applies a provider outcome exactly once, in ONE transaction:
 *  1. Record the event id (PK dedupe). A duplicate delivery stops here, even a concurrent
 *     one, because the second INSERT waits for the first transaction and then conflicts.
 *  2. For a capture, take locks in the global order: event (share) -> seats (by id) ->
 *     bookings (by id) -> payment. This is the same order as booking creation, so no
 *     deadlock is possible.
 *  3. Decide (see docs/architecture.md, "Late payments"), transition, and write any
 *     follow-up jobs (tickets / refund) to the outbox.
 */
export async function applyPaymentEvent(provider: ProviderName, evt: PaymentEvent): Promise<ApplyResult> {
  return withTransaction(async (tx) => {
    const fresh = await repo.recordPaymentEvent(tx, { provider, eventId: evt.eventId, type: evt.outcome, payload: evt.raw });
    if (!fresh) return 'duplicate';

    const payment = await repo.findPaymentByOrder(tx, provider, evt.orderId);
    // Roll back (so the event isn't marked seen) and make the provider retry: the order id
    // may simply not be committed yet if the webhook beat our own "store order" write.
    if (!payment) throw new UnknownOrderError(evt.orderId);

    const result = evt.outcome === 'captured' ? await applyCapture(tx, payment, evt) : await applyFailure(tx, payment, evt);
    await repo.setPaymentEventResult(tx, provider, evt.eventId, payment.id, result);
    logger.info({ paymentId: payment.id, bookingId: payment.bookingId, eventId: evt.eventId, result }, 'payment event applied');
    return result;
  });
}

async function applyFailure(tx: TxClient, payment: repo.PaymentRecord, evt: PaymentEvent): Promise<ApplyResult> {
  const locked = await repo.lockPayment(tx, payment.id);
  if (locked?.status !== 'PENDING') return 'already-settled';
  await repo.settlePayment(tx, payment.id, {
    status: 'FAILED',
    providerPaymentId: evt.providerPaymentId,
    providerEventId: evt.eventId,
    raw: evt.raw,
  });
  return 'failed';
}

async function applyCapture(tx: TxClient, payment: repo.PaymentRecord, evt: PaymentEvent): Promise<ApplyResult> {
  const snapshot = await bookingsRepo.findBooking(tx, payment.bookingId);
  if (!snapshot) throw new Error(`booking ${payment.bookingId} missing for payment ${payment.id}`);
  const event = await lockEvent(tx, snapshot.eventId, 'share');
  const seatIds = await bookingsRepo.listBookingSeatIds(tx, snapshot.id);
  await bookingsRepo.lockSeatsInOrder(tx, snapshot.eventId, seatIds);

  const claims = await bookingsRepo.findActiveClaims(tx, snapshot.eventId, seatIds);
  const lapsedOthers = [
    ...new Set(claims.filter((c) => c.bookingId !== snapshot.id && c.status === 'HELD' && c.holdLapsed).map((c) => c.bookingId)),
  ];
  await bookingsRepo.lockBookingsInOrder(tx, [snapshot.id, ...lapsedOthers]);
  const locked = await repo.lockPayment(tx, payment.id);
  if (!locked || (locked.status !== 'PENDING' && locked.status !== 'FAILED')) return 'already-settled';

  const booking = await bookingsRepo.findBooking(tx, snapshot.id);
  if (!booking) throw new Error(`booking ${snapshot.id} vanished`);
  const base = { providerPaymentId: evt.providerPaymentId, providerEventId: evt.eventId, raw: evt.raw };

  const refund = async (reason: string): Promise<ApplyResult> => {
    await repo.settlePayment(tx, payment.id, { ...base, status: 'REFUND_PENDING', refundReason: reason });
    await addToOutbox(tx, 'refund', { paymentId: payment.id }, { jobId: jobId('refund', payment.id) });
    return 'refund';
  };
  const markPaid = async (lateReclaim: boolean): Promise<ApplyResult> => {
    await transitionBooking(tx, booking.id, 'PAID', { lateReclaim });
    await repo.settlePayment(tx, payment.id, { ...base, status: 'SUCCEEDED' });
    await addToOutbox(tx, 'generate-tickets', { bookingId: booking.id }, { jobId: jobId('generate-tickets', booking.id) });
    return lateReclaim ? 'reclaimed' : 'paid';
  };

  if (evt.amountPaise !== locked.amountPaise) return refund('AMOUNT_MISMATCH');

  // Still HELD (even if the hold just lapsed): the booking still owns its seats.
  if (booking.status === 'HELD') return markPaid(false);

  // The race: the expiry job won, then the money arrived.
  if (booking.status === 'EXPIRED') {
    if (event?.status !== 'PUBLISHED') return refund('EVENT_NOT_ACTIVE');
    for (const id of lapsedOthers.sort()) {
      await transitionBooking(tx, id, 'EXPIRED', { guard: (b) => b.status === 'HELD' && b.holdLapsed });
    }
    const stillTaken = (await bookingsRepo.findActiveClaims(tx, booking.eventId, seatIds)).filter((c) => c.bookingId !== booking.id);
    if (stillTaken.length === 0) return markPaid(true);
    return refund('SEATS_TAKEN');
  }

  // PAID by another payment (double payment), CANCELLED or REFUNDED.
  return refund(booking.status === 'PAID' ? 'DUPLICATE_PAYMENT' : `BOOKING_${booking.status}`);
}

// ---------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------

export async function handleWebhook(providerName: string, rawBody: unknown, headers: IncomingHttpHeaders): Promise<{ result: ApplyResult | 'ignored' }> {
  if (!isProviderName(providerName)) throw AppError.notFound('Payment provider');
  if (!Buffer.isBuffer(rawBody)) throw AppError.badRequest('BAD_REQUEST', 'Expected a raw request body');
  let provider;
  try {
    provider = getPaymentProvider(providerName);
  } catch {
    throw AppError.notFound('Payment provider');
  }
  if (!provider.verifySignature(rawBody, headers)) {
    throw AppError.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
  }

  let evt: PaymentEvent | null;
  try {
    evt = provider.parseEvent(rawBody, headers);
  } catch (err) {
    if (err instanceof InvalidWebhookError) throw AppError.badRequest('INVALID_WEBHOOK', err.message);
    throw err;
  }
  if (!evt) return { result: 'ignored' };

  try {
    return { result: await applyPaymentEvent(providerName, evt) };
  } catch (err) {
    if (err instanceof UnknownOrderError) {
      throw new AppError(503, 'UNKNOWN_ORDER', 'Order not recognised yet; retry later');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// Reconciliation (repeatable job)
// ---------------------------------------------------------------------------------------

export interface ReconcileSummary {
  checked: number;
  applied: Partial<Record<ApplyResult, number>>;
  failedNoOrder: number;
  abandoned: number;
  errors: number;
}

/**
 * Catches missed webhooks: asks the provider about payments that have been PENDING for
 * too long and applies the answer through the SAME `applyPaymentEvent` path, with a
 * deterministic event id, so a webhook that shows up later is a harmless no-op.
 */
export async function reconcilePendingPayments(limit = 200): Promise<ReconcileSummary> {
  const stale = await repo.listStalePendingPayments(pool, env.RECONCILE_PENDING_AFTER_MINUTES, env.PAYMENT_ABANDON_AFTER_MINUTES, limit);
  const summary: ReconcileSummary = { checked: stale.length, applied: {}, failedNoOrder: 0, abandoned: 0, errors: 0 };

  for (const p of stale) {
    try {
      if (!p.providerOrderId) {
        // Order creation never completed; nobody can have paid it.
        if (await repo.markPaymentFailedIfPending(pool, p.id, 'ORDER_NOT_CREATED')) summary.failedNoOrder++;
        continue;
      }
      const providerName = providerNameOf(p.provider);
      const status = await getPaymentProvider(providerName).fetchOrderStatus(p.providerOrderId);
      let result: ApplyResult | undefined;
      if (status.status === 'paid') {
        result = await applyPaymentEvent(providerName, {
          eventId: `reconcile:captured:${status.providerPaymentId}`,
          orderId: p.providerOrderId,
          providerPaymentId: status.providerPaymentId,
          outcome: 'captured',
          amountPaise: status.amountPaise,
          raw: status.raw,
        });
      } else if (status.status === 'failed') {
        result = await applyPaymentEvent(providerName, {
          eventId: `reconcile:failed:${p.providerOrderId}`,
          orderId: p.providerOrderId,
          providerPaymentId: null,
          outcome: 'failed',
          amountPaise: 0,
          raw: status.raw,
        });
      } else if (p.abandoned) {
        if (await repo.markPaymentFailedIfPending(pool, p.id, 'ABANDONED')) summary.abandoned++;
      }
      if (result) summary.applied[result] = (summary.applied[result] ?? 0) + 1;
    } catch (err) {
      summary.errors++;
      logger.error({ err, paymentId: p.id }, 'reconciliation failed for payment');
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------------------
// Refunds (job)
// ---------------------------------------------------------------------------------------

/**
 * Refund job handler. The provider call happens outside any transaction, keyed by our
 * payment id so a retry after a crash can't refund twice. The status flip is guarded,
 * so running the job twice is a no-op.
 */
export async function processRefund(paymentId: string): Promise<'refunded' | 'noop'> {
  const payment = await repo.findPaymentById(pool, paymentId);
  if (payment?.status !== 'REFUND_PENDING') return 'noop';
  if (!payment.providerPaymentId) throw new Error(`payment ${paymentId} has no provider payment id to refund`);

  const { refundId } = await getPaymentProvider(providerNameOf(payment.provider)).refund({
    providerPaymentId: payment.providerPaymentId,
    amountPaise: payment.amountPaise,
    idempotencyKey: payment.id,
  });

  return withTransaction(async (tx) => {
    if (!(await repo.markRefunded(tx, paymentId, refundId))) return 'noop';
    await addToOutbox(tx, 'send-notification', { kind: 'refund-issued', paymentId }, { jobId: jobId('notify', 'refund', paymentId) });
    return 'refunded';
  });
}

/**
 * Cancelling an event: HELD bookings are cancelled, PAID bookings are refunded (booking
 * -> REFUNDED, payment -> REFUND_PENDING + refund job). Runs in the caller's transaction,
 * which holds the event FOR UPDATE, so no booking or capture can sneak in meanwhile.
 */
export async function releaseEventBookings(tx: TxClient, eventId: string): Promise<{ cancelled: number; refunded: number }> {
  const { rows } = await tx.query<{ bookingId: string }>(
    `SELECT DISTINCT booking_id AS "bookingId" FROM booking_seats WHERE event_id = $1 AND is_active`,
    [eventId],
  );
  const bookings = await bookingsRepo.lockBookingsInOrder(tx, rows.map((r) => r.bookingId));
  let cancelled = 0;
  let refunded = 0;
  for (const booking of bookings) {
    if (booking.status === 'HELD') {
      await transitionBooking(tx, booking.id, 'CANCELLED');
      cancelled++;
    } else if (booking.status === 'PAID') {
      await transitionBooking(tx, booking.id, 'REFUNDED');
      const payment = await repo.lockSucceededPaymentForBooking(tx, booking.id);
      if (payment) {
        await repo.markRefundPending(tx, payment.id, 'EVENT_CANCELLED');
        await addToOutbox(tx, 'refund', { paymentId: payment.id }, { jobId: jobId('refund', payment.id) });
      }
      refunded++;
    }
  }
  return { cancelled, refunded };
}
