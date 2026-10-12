import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { hmacSha256, safeEqual } from '../../../lib/hmac.js';
import {
  InvalidWebhookError,
  type CreateOrderInput,
  type OrderStatus,
  type PaymentEvent,
  type PaymentProvider,
  type ProviderOrder,
  type RefundInput,
} from './types.js';

/**
 * Razorpay (test mode) over its REST API using fetch; no SDK dependency.
 * Assumes "auto-capture" is enabled on the Razorpay account, so a successful payment
 * produces `payment.captured`.
 */
export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  baseUrl?: string;
}

const OrderResponseSchema = z.object({ id: z.string() });
const PaymentEntitySchema = z.object({
  id: z.string(),
  order_id: z.string().nullable(),
  amount: z.number().int(),
  status: z.string(),
});
const PaymentsListSchema = z.object({ items: z.array(PaymentEntitySchema) });
const RefundSchema = z.object({ id: z.string(), notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional() });
const RefundsListSchema = z.object({ items: z.array(RefundSchema) });
const WebhookSchema = z.object({
  event: z.string(),
  payload: z.object({ payment: z.object({ entity: PaymentEntitySchema }).optional() }),
});

export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  private readonly baseUrl: string;

  constructor(private readonly config: RazorpayConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.razorpay.com/v1';
  }

  private async call<S extends z.ZodType>(method: 'GET' | 'POST', path: string, schema: S, body?: unknown): Promise<z.output<S>> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`razorpay ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return schema.parse(JSON.parse(text));
  }

  async createOrder(input: CreateOrderInput): Promise<ProviderOrder> {
    const order = await this.call('POST', '/orders', OrderResponseSchema, {
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.paymentId,
      notes: { booking_id: input.bookingId, payment_id: input.paymentId },
    });
    return {
      orderId: order.id,
      checkout: { provider: 'razorpay', keyId: this.config.keyId, orderId: order.id, amountPaise: input.amountPaise, currency: 'INR' },
    };
  }

  verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    const header = headers['x-razorpay-signature'];
    return typeof header === 'string' && safeEqual(header, hmacSha256(this.config.webhookSecret, rawBody));
  }

  parseEvent(rawBody: Buffer, headers: IncomingHttpHeaders): PaymentEvent | null {
    const eventId = headers['x-razorpay-event-id'];
    if (typeof eventId !== 'string' || !eventId) throw new InvalidWebhookError('missing x-razorpay-event-id');
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidWebhookError('body is not JSON');
    }
    const parsed = WebhookSchema.safeParse(json);
    if (!parsed.success) throw new InvalidWebhookError('unexpected razorpay event shape');
    const { event, payload } = parsed.data;
    if (event !== 'payment.captured' && event !== 'payment.failed') return null;
    const payment = payload.payment?.entity;
    if (!payment?.order_id) throw new InvalidWebhookError('payment event without order_id');
    return {
      eventId,
      orderId: payment.order_id,
      providerPaymentId: payment.id,
      outcome: event === 'payment.captured' ? 'captured' : 'failed',
      amountPaise: payment.amount,
      raw: json,
    };
  }

  async fetchOrderStatus(orderId: string): Promise<OrderStatus> {
    const { items } = await this.call('GET', `/orders/${encodeURIComponent(orderId)}/payments`, PaymentsListSchema);
    const captured = items.find((p) => p.status === 'captured');
    if (captured) return { status: 'paid', providerPaymentId: captured.id, amountPaise: captured.amount, raw: captured };
    // Any attempt still in flight means the customer may yet pay.
    if (items.some((p) => p.status === 'created' || p.status === 'authorized')) return { status: 'pending' };
    if (items.length > 0) return { status: 'failed', raw: items };
    return { status: 'pending' };
  }

  async refund(input: RefundInput): Promise<{ refundId: string }> {
    // Razorpay has no idempotency header for refunds, so check for an earlier refund carrying
    // our key first: a job that crashed after refunding must not refund again on retry.
    const path = `/payments/${encodeURIComponent(input.providerPaymentId)}`;
    const existing = await this.call('GET', `${path}/refunds`, RefundsListSchema);
    const prior = existing.items.find(
      (r) => r.notes && !Array.isArray(r.notes) && r.notes.idempotency_key === input.idempotencyKey,
    );
    if (prior) return { refundId: prior.id };
    const refund = await this.call('POST', `${path}/refund`, RefundSchema, {
      amount: input.amountPaise,
      notes: { idempotency_key: input.idempotencyKey },
    });
    return { refundId: refund.id };
  }
}
