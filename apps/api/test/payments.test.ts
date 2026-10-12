import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { expireHold } from '../src/modules/bookings/hold-expiry.service.js';
import { processRefund, reconcilePendingPayments } from '../src/modules/payments/payments.service.js';
import {
  deliverMockWebhooks,
  InMemoryMockOrderStore,
  MOCK_SIGNATURE_HEADER,
  signMockPayload,
  type MockConfig,
} from '../src/modules/payments/providers/mock.js';
import { configurePaymentProviders } from '../src/modules/payments/providers/registry.js';
import {
  activeSeatCount,
  bookingStatus,
  bookSeats,
  createPublishedEvent,
  createUser,
  lapseHold,
  outboxRows,
  useTestServer,
  type TestUser,
} from './helpers.js';

const { url } = useTestServer();

const SECRET = process.env.MOCK_WEBHOOK_SECRET ?? '';
const baseConfig: MockConfig = { secret: SECRET, delayMs: 0, outcome: 'success', duplicates: 0, outOfOrder: false, dropWebhooks: false };

let store: InMemoryMockOrderStore;
let scheduled: string[];

beforeEach(() => {
  store = new InMemoryMockOrderStore();
  scheduled = [];
  configurePaymentProviders({
    mockStore: store,
    scheduleMockDelivery: (orderId) => {
      scheduled.push(orderId);
      return Promise.resolve();
    },
    mockConfig: baseConfig,
  });
});

interface Paid {
  user: TestUser;
  eventId: string;
  seatIds: string[];
  bookingId: string;
  paymentId: string;
  orderId: string;
  amountPaise: number;
}

async function heldAndOrdered(seats = 2): Promise<Paid> {
  const { eventId, seatIds } = await createPublishedEvent(seats);
  const user = await createUser();
  const bookingId = await bookSeats(url(), user, eventId, seatIds);
  const res = await request(url()).post(`/bookings/${bookingId}/pay`).set(user.auth);
  expect(res.status).toBe(201);
  return {
    user,
    eventId,
    seatIds,
    bookingId,
    paymentId: res.body.payment.id,
    orderId: res.body.payment.providerOrderId,
    amountPaise: res.body.payment.amountPaise,
  };
}

function webhookBody(evt: { id: string; type: string; orderId: string; amountPaise: number; paymentId?: string }): string {
  return JSON.stringify({
    id: evt.id,
    type: evt.type,
    created_at: Math.floor(Date.now() / 1000),
    data: { order_id: evt.orderId, payment_id: evt.paymentId ?? 'pay_test_1', amount_paise: evt.amountPaise },
  });
}

function postWebhook(body: string, signature = signMockPayload(SECRET, body)) {
  return request(url())
    .post('/webhooks/payments/mock')
    .set('content-type', 'application/json')
    .set(MOCK_SIGNATURE_HEADER, signature)
    .send(body);
}

async function paymentRow(id: string): Promise<{ status: string; refundReason: string | null }> {
  const { rows } = await pool.query<{ status: string; refundReason: string | null }>(
    `SELECT status, refund_reason AS "refundReason" FROM payments WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error('payment not found');
  return row;
}

describe('POST /bookings/:id/pay', () => {
  it('creates one provider order; repeated calls return the same in-flight payment', async () => {
    const p = await heldAndOrdered();
    expect(p.orderId).toMatch(/^order_mock_/);
    expect(scheduled).toEqual([p.orderId]);

    const again = await Promise.all([1, 2, 3].map(() => request(url()).post(`/bookings/${p.bookingId}/pay`).set(p.user.auth)));
    for (const r of again) expect(r.body.payment.id).toBe(p.paymentId);
    expect(scheduled).toHaveLength(1);
  });

  it('rejects paying for an expired hold and for someone else’s booking', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const user = await createUser();
    const bookingId = await bookSeats(url(), user, eventId, seatIds);
    await lapseHold(bookingId);
    const expired = await request(url()).post(`/bookings/${bookingId}/pay`).set(user.auth);
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('HOLD_EXPIRED');

    const other = await createUser();
    expect((await request(url()).post(`/bookings/${bookingId}/pay`).set(other.auth)).status).toBe(404);
  });
});

describe('payment webhooks', () => {
  it('a valid capture marks the booking PAID and queues ticket generation', async () => {
    const p = await heldAndOrdered();
    const res = await postWebhook(webhookBody({ id: 'evt_1', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise }));
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('paid');
    expect(await bookingStatus(p.bookingId)).toBe('PAID');
    expect((await paymentRow(p.paymentId)).status).toBe('SUCCEEDED');
    expect((await outboxRows('generate-tickets')).map((r) => r.payload)).toEqual([{ bookingId: p.bookingId }]);
  });

  it('duplicate webhooks (even concurrent) are applied exactly once', async () => {
    const p = await heldAndOrdered();
    const body = webhookBody({ id: 'evt_dup', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise });
    const responses = await Promise.all(Array.from({ length: 10 }, () => postWebhook(body)));

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
    const results = responses.map((r) => r.body.result as string);
    expect(results.filter((r) => r === 'paid')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(9);
    expect(await outboxRows('generate-tickets')).toHaveLength(1);
  });

  it('rejects a bad signature without touching anything', async () => {
    const p = await heldAndOrdered();
    const body = webhookBody({ id: 'evt_forged', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise });
    const res = await postWebhook(body, signMockPayload('some-other-secret-entirely', body));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');

    // Signed for a different body (tampered amount).
    const parsed = JSON.parse(body);
    parsed.data.amount_paise = 1;
    const tampered = await postWebhook(JSON.stringify(parsed), signMockPayload(SECRET, body));
    expect(tampered.status).toBe(401);

    expect(await bookingStatus(p.bookingId)).toBe('HELD');
    expect((await paymentRow(p.paymentId)).status).toBe('PENDING');
    const { rows } = await pool.query(`SELECT 1 FROM payment_events`);
    expect(rows).toHaveLength(0);
  });

  it('a stale "failed" arriving after "captured" (out of order) does not undo the payment', async () => {
    const p = await heldAndOrdered();
    await postWebhook(webhookBody({ id: 'evt_ok', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise }));
    const stale = await postWebhook(webhookBody({ id: 'evt_old_fail', type: 'payment.failed', orderId: p.orderId, amountPaise: p.amountPaise }));
    expect(stale.body.result).toBe('already-settled');
    expect((await paymentRow(p.paymentId)).status).toBe('SUCCEEDED');
    expect(await bookingStatus(p.bookingId)).toBe('PAID');
  });

  it('a failed payment keeps the hold, and the user can pay again', async () => {
    const p = await heldAndOrdered();
    const res = await postWebhook(webhookBody({ id: 'evt_fail', type: 'payment.failed', orderId: p.orderId, amountPaise: p.amountPaise }));
    expect(res.body.result).toBe('failed');
    expect(await bookingStatus(p.bookingId)).toBe('HELD');

    const retry = await request(url()).post(`/bookings/${p.bookingId}/pay`).set(p.user.auth);
    expect(retry.status).toBe(201);
    expect(retry.body.payment.id).not.toBe(p.paymentId);
  });

  it('an unknown order gets 503 so the provider retries (the webhook may beat our own commit)', async () => {
    const body = webhookBody({ id: 'evt_unknown', type: 'payment.captured', orderId: 'order_mock_nope', amountPaise: 100 });
    const res = await postWebhook(body);
    expect(res.status).toBe(503);
    const { rows } = await pool.query(`SELECT 1 FROM payment_events`);
    expect(rows).toHaveLength(0); // not marked as seen: the retry will be processed
  });

  it('ignores event types it does not act on', async () => {
    const p = await heldAndOrdered();
    const res = await postWebhook(webhookBody({ id: 'evt_auth', type: 'payment.authorized', orderId: p.orderId, amountPaise: p.amountPaise }));
    expect(res.body.result).toBe('ignored');
  });
});

describe('late payment race (capture after the hold expired)', () => {
  it('seats still free: the booking re-claims them and becomes PAID', async () => {
    const p = await heldAndOrdered();
    await lapseHold(p.bookingId);
    await expireHold(p.bookingId);
    expect(await bookingStatus(p.bookingId)).toBe('EXPIRED');
    expect(await activeSeatCount(p.eventId)).toBe(0);

    const res = await postWebhook(webhookBody({ id: 'evt_late', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise }));
    expect(res.body.result).toBe('reclaimed');
    expect(await bookingStatus(p.bookingId)).toBe('PAID');
    expect(await activeSeatCount(p.eventId)).toBe(2);
    expect((await paymentRow(p.paymentId)).status).toBe('SUCCEEDED');
  });

  it('seats taken by someone else: the payment is marked for refund and a refund job is queued', async () => {
    const p = await heldAndOrdered();
    await lapseHold(p.bookingId);
    await expireHold(p.bookingId);
    const rival = await createUser();
    const rivalBooking = await bookSeats(url(), rival, p.eventId, [p.seatIds[0] ?? '']);

    const res = await postWebhook(webhookBody({ id: 'evt_late2', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise }));
    expect(res.body.result).toBe('refund');
    expect(await bookingStatus(p.bookingId)).toBe('EXPIRED');
    expect(await bookingStatus(rivalBooking)).toBe('HELD');
    expect(await paymentRow(p.paymentId)).toEqual({ status: 'REFUND_PENDING', refundReason: 'SEATS_TAKEN' });
    expect((await outboxRows('refund')).map((r) => r.payload)).toEqual([{ paymentId: p.paymentId }]);

    // The refund job (twice: idempotent).
    expect(await processRefund(p.paymentId)).toBe('refunded');
    expect(await processRefund(p.paymentId)).toBe('noop');
    expect((await paymentRow(p.paymentId)).status).toBe('REFUNDED');
    expect((await outboxRows('send-notification')).map((r) => r.payload)).toEqual([{ kind: 'refund-issued', paymentId: p.paymentId }]);
  });

  it('a seat held by someone whose hold ALSO lapsed is reclaimed (lazy expiry inside settlement)', async () => {
    const p = await heldAndOrdered(1);
    await lapseHold(p.bookingId);
    await expireHold(p.bookingId);
    const rivalBooking = await bookSeats(url(), await createUser(), p.eventId, p.seatIds);
    await lapseHold(rivalBooking);

    const res = await postWebhook(webhookBody({ id: 'evt_late3', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise }));
    expect(res.body.result).toBe('reclaimed');
    expect(await bookingStatus(rivalBooking)).toBe('EXPIRED');
    expect(await bookingStatus(p.bookingId)).toBe('PAID');
  });

  it('a capture for a cancelled booking is refunded', async () => {
    const p = await heldAndOrdered();
    await request(url()).post(`/bookings/${p.bookingId}/cancel`).set(p.user.auth).expect(200);
    const res = await postWebhook(webhookBody({ id: 'evt_c', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise }));
    expect(res.body.result).toBe('refund');
    expect((await paymentRow(p.paymentId)).refundReason).toBe('BOOKING_CANCELLED');
  });

  it('an amount mismatch is never applied', async () => {
    const p = await heldAndOrdered();
    const res = await postWebhook(webhookBody({ id: 'evt_amt', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise - 1 }));
    expect(res.body.result).toBe('refund');
    expect(await bookingStatus(p.bookingId)).toBe('HELD');
  });
});

describe('payment reconciliation', () => {
  it('fixes a missed webhook by asking the provider', async () => {
    const p = await heldAndOrdered();
    // The gateway settles the order but the webhook is lost.
    const delivered = await deliverMockWebhooks(p.orderId, {
      store,
      config: { ...baseConfig, dropWebhooks: true },
      post: () => Promise.reject(new Error('should not be called')),
    });
    expect(delivered.sent).toBe(0);
    expect(await bookingStatus(p.bookingId)).toBe('HELD');

    // Not yet stale: reconciliation leaves it alone.
    expect((await reconcilePendingPayments()).checked).toBe(0);

    await pool.query(`UPDATE payments SET created_at = now() - interval '30 minutes' WHERE id = $1`, [p.paymentId]);
    const summary = await reconcilePendingPayments();
    expect(summary.applied).toEqual({ paid: 1 });
    expect(await bookingStatus(p.bookingId)).toBe('PAID');

    // The webhook finally shows up: harmless.
    const order = await store.get(p.orderId);
    const late = await postWebhook(
      webhookBody({ id: order?.eventId ?? 'evt', type: 'payment.captured', orderId: p.orderId, amountPaise: p.amountPaise }),
    );
    expect(late.body.result).toBe('already-settled');
  });

  it('fails a payment whose order was never created', async () => {
    const { eventId, seatIds } = await createPublishedEvent(1);
    const bookingId = await bookSeats(url(), await createUser(), eventId, seatIds);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO payments (booking_id, provider, amount_paise, created_at) VALUES ($1, 'mock', 1000, now() - interval '1 hour') RETURNING id`,
      [bookingId],
    );
    const summary = await reconcilePendingPayments();
    expect(summary.failedNoOrder).toBe(1);
    expect((await paymentRow(rows[0]?.id ?? '')).status).toBe('FAILED');
  });
});

describe('MockProvider end to end', () => {
  it('delivers a signed webhook; duplicates and an out-of-order stale event are absorbed', async () => {
    const p = await heldAndOrdered();
    const results: string[] = [];
    const delivered = await deliverMockWebhooks(p.orderId, {
      store,
      config: { ...baseConfig, duplicates: 3, outOfOrder: true },
      post: async (body, headers) => {
        const res = await request(url()).post('/webhooks/payments/mock').set(headers).send(body);
        results.push(res.body.result as string);
        return res.status;
      },
    });

    expect(delivered.sent).toBe(5);
    expect(results).toEqual(['paid', 'duplicate', 'duplicate', 'duplicate', 'already-settled']);
    expect(await bookingStatus(p.bookingId)).toBe('PAID');
  });

  it('a retried delivery job re-sends the same event id (deduped)', async () => {
    const p = await heldAndOrdered();
    const post = async (body: string, headers: Record<string, string>): Promise<number> =>
      (await request(url()).post('/webhooks/payments/mock').set(headers).send(body)).status;
    await deliverMockWebhooks(p.orderId, { store, config: baseConfig, post });
    await deliverMockWebhooks(p.orderId, { store, config: baseConfig, post });
    const { rows } = await pool.query(`SELECT 1 FROM payment_events`);
    expect(rows).toHaveLength(1);
  });
});

describe('event cancellation', () => {
  it('cancels HELD bookings and refunds PAID ones', async () => {
    const organizer = await createUser('organizer');
    const { eventId, seatIds } = await createPublishedEvent(2, organizer);
    const buyer = await createUser();
    const paidBooking = await bookSeats(url(), buyer, eventId, [seatIds[0] ?? '']);
    const pay = await request(url()).post(`/bookings/${paidBooking}/pay`).set(buyer.auth);
    await postWebhook(webhookBody({ id: 'evt_ec', type: 'payment.captured', orderId: pay.body.payment.providerOrderId, amountPaise: 1000 }));
    const heldBooking = await bookSeats(url(), await createUser(), eventId, [seatIds[1] ?? '']);

    const res = await request(url()).post(`/events/${eventId}/cancel`).set(organizer.auth);
    expect(res.status).toBe(200);
    expect(await bookingStatus(paidBooking)).toBe('REFUNDED');
    expect(await bookingStatus(heldBooking)).toBe('CANCELLED');
    expect((await paymentRow(pay.body.payment.id)).status).toBe('REFUND_PENDING');
    expect(await activeSeatCount(eventId)).toBe(0);
  });
});
