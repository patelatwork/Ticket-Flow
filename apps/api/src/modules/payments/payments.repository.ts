import type { Queryable, TxClient } from '../../db/tx.js';

export const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUND_PENDING', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentRecord {
  id: string;
  bookingId: string;
  provider: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  providerEventId: string | null;
  status: PaymentStatus;
  amountPaise: number;
  currency: string;
  checkout: Record<string, unknown> | null;
  refundReason: string | null;
  providerRefundId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const PAYMENT_COLUMNS = `id, booking_id AS "bookingId", provider, provider_order_id AS "providerOrderId",
  provider_payment_id AS "providerPaymentId", provider_event_id AS "providerEventId", status,
  amount_paise AS "amountPaise", currency, checkout, refund_reason AS "refundReason",
  provider_refund_id AS "providerRefundId", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function findPaymentById(db: Queryable, id: string): Promise<PaymentRecord | undefined> {
  const { rows } = await db.query<PaymentRecord>(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`, [id]);
  return rows[0];
}

export async function lockPayment(tx: TxClient, id: string): Promise<PaymentRecord | undefined> {
  const { rows } = await tx.query<PaymentRecord>(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0];
}

export async function findPaymentByOrder(db: Queryable, provider: string, orderId: string): Promise<PaymentRecord | undefined> {
  const { rows } = await db.query<PaymentRecord>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE provider = $1 AND provider_order_id = $2`,
    [provider, orderId],
  );
  return rows[0];
}

/** Caller holds the booking lock, which serializes concurrent "pay" requests. */
export async function findPendingPaymentForBooking(tx: TxClient, bookingId: string): Promise<PaymentRecord | undefined> {
  const { rows } = await tx.query<PaymentRecord>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE booking_id = $1 AND status = 'PENDING' FOR UPDATE`,
    [bookingId],
  );
  return rows[0];
}

export async function lockSucceededPaymentForBooking(tx: TxClient, bookingId: string): Promise<PaymentRecord | undefined> {
  const { rows } = await tx.query<PaymentRecord>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE booking_id = $1 AND status = 'SUCCEEDED' ORDER BY id FOR UPDATE`,
    [bookingId],
  );
  return rows[0];
}

export async function latestPaymentForBooking(db: Queryable, bookingId: string): Promise<PaymentRecord | undefined> {
  const { rows } = await db.query<PaymentRecord>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE booking_id = $1 ORDER BY created_at DESC, id LIMIT 1`,
    [bookingId],
  );
  return rows[0];
}

export async function insertPayment(
  tx: TxClient,
  payment: { bookingId: string; provider: string; amountPaise: number },
): Promise<PaymentRecord> {
  const { rows } = await tx.query<PaymentRecord>(
    `INSERT INTO payments (booking_id, provider, amount_paise) VALUES ($1, $2, $3) RETURNING ${PAYMENT_COLUMNS}`,
    [payment.bookingId, payment.provider, payment.amountPaise],
  );
  const row = rows[0];
  if (!row) throw new Error('insertPayment returned no row');
  return row;
}

/** Only fills an empty order id: a concurrent request that got there first wins. */
export async function setPaymentOrder(
  db: Queryable,
  id: string,
  orderId: string,
  checkout: Record<string, unknown>,
): Promise<PaymentRecord | undefined> {
  const { rows } = await db.query<PaymentRecord>(
    `UPDATE payments SET provider_order_id = $2, checkout = $3::jsonb, updated_at = now()
      WHERE id = $1 AND provider_order_id IS NULL
      RETURNING ${PAYMENT_COLUMNS}`,
    [id, orderId, JSON.stringify(checkout)],
  );
  return rows[0];
}

export async function settlePayment(
  tx: TxClient,
  id: string,
  update: {
    status: PaymentStatus;
    providerPaymentId: string | null;
    providerEventId: string;
    raw: unknown;
    refundReason?: string;
  },
): Promise<void> {
  await tx.query(
    `UPDATE payments
        SET status = $2::payment_status,
            provider_payment_id = COALESCE($3, provider_payment_id),
            provider_event_id = $4,
            raw = $5::jsonb,
            refund_reason = $6,
            succeeded_at = CASE WHEN $2::payment_status = 'SUCCEEDED' THEN now() ELSE succeeded_at END,
            updated_at = now()
      WHERE id = $1`,
    [id, update.status, update.providerPaymentId, update.providerEventId, JSON.stringify(update.raw ?? null), update.refundReason ?? null],
  );
}

export async function markRefundPending(tx: TxClient, id: string, reason: string): Promise<void> {
  await tx.query(`UPDATE payments SET status = 'REFUND_PENDING', refund_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
}

/** Guarded: only the first completion of a refund wins. */
export async function markRefunded(tx: TxClient, id: string, refundId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE payments SET status = 'REFUNDED', provider_refund_id = $2, refunded_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'REFUND_PENDING'`,
    [id, refundId],
  );
  return rowCount === 1;
}

/** Guarded: never overwrites an outcome that arrived meanwhile. */
export async function markPaymentFailedIfPending(db: Queryable, id: string, reason: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE payments SET status = 'FAILED', refund_reason = NULL, raw = jsonb_build_object('reason', $2::text), updated_at = now()
      WHERE id = $1 AND status = 'PENDING'`,
    [id, reason],
  );
  return rowCount === 1;
}

export interface StalePayment {
  id: string;
  provider: string;
  providerOrderId: string | null;
  abandoned: boolean;
}

export async function listStalePendingPayments(
  db: Queryable,
  olderThanMinutes: number,
  abandonAfterMinutes: number,
  limit: number,
): Promise<StalePayment[]> {
  const { rows } = await db.query<StalePayment>(
    `SELECT id, provider, provider_order_id AS "providerOrderId",
            created_at < now() - make_interval(mins => $2) AS abandoned
       FROM payments
      WHERE status = 'PENDING' AND created_at < now() - make_interval(mins => $1)
      ORDER BY created_at
      LIMIT $3`,
    [olderThanMinutes, abandonAfterMinutes, limit],
  );
  return rows;
}

// ---- payment events (webhook dedupe) ----

/** Returns false if this (provider, event id) was already recorded: a duplicate delivery. */
export async function recordPaymentEvent(
  tx: TxClient,
  event: { provider: string; eventId: string; type: string; payload: unknown },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `INSERT INTO payment_events (provider, provider_event_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    [event.provider, event.eventId, event.type, JSON.stringify(event.payload ?? null)],
  );
  return rowCount === 1;
}

export async function setPaymentEventResult(
  tx: TxClient,
  provider: string,
  eventId: string,
  paymentId: string | null,
  result: string,
): Promise<void> {
  await tx.query(
    `UPDATE payment_events SET payment_id = $3, result = $4 WHERE provider = $1 AND provider_event_id = $2`,
    [provider, eventId, paymentId, result],
  );
}
