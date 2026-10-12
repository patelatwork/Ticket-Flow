import type { IncomingHttpHeaders } from 'node:http';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { randomToken } from '../../../lib/crypto.js';
import { hmacSha256, safeEqual } from '../../../lib/hmac.js';
import { logger } from '../../../lib/logger.js';
import {
  InvalidWebhookError,
  type CreateOrderInput,
  type OrderStatus,
  type PaymentEvent,
  type PaymentProvider,
  type ProviderOrder,
  type RefundInput,
} from './types.js';

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

/**
 * A fake payment gateway that behaves like a real one where it matters for correctness:
 * orders are settled asynchronously, results arrive as signed webhooks after a delay,
 * a retried delivery re-sends the SAME event id, and the gateway can be queried for an
 * order's status (used by reconciliation). It can also misbehave on purpose:
 * duplicates, out-of-order events and dropped webhooks.
 */
export interface MockConfig {
  secret: string;
  delayMs: number;
  outcome: 'success' | 'failure';
  duplicates: number;
  outOfOrder: boolean;
  dropWebhooks: boolean;
}

const MockOrderSchema = z.object({
  orderId: z.string(),
  paymentId: z.uuid(),
  amountPaise: z.number().int().positive(),
  outcome: z.enum(['success', 'failure']),
  status: z.enum(['created', 'paid', 'failed']),
  providerPaymentId: z.string().nullable(),
  eventId: z.string().nullable(),
  staleEventId: z.string().nullable(),
});
export type MockOrder = z.infer<typeof MockOrderSchema>;

/** The "gateway's database": shared by the API (creates orders) and worker (settles them). */
export interface MockOrderStore {
  get(orderId: string): Promise<MockOrder | undefined>;
  save(order: MockOrder): Promise<void>;
}

export class RedisMockOrderStore implements MockOrderStore {
  constructor(private readonly redis: Redis) {}

  async get(orderId: string): Promise<MockOrder | undefined> {
    const raw = await this.redis.get(`mockpay:order:${orderId}`);
    return raw === null ? undefined : MockOrderSchema.parse(JSON.parse(raw));
  }

  async save(order: MockOrder): Promise<void> {
    await this.redis.set(`mockpay:order:${order.orderId}`, JSON.stringify(order), 'EX', 7 * 24 * 3600);
  }
}

export class InMemoryMockOrderStore implements MockOrderStore {
  readonly orders = new Map<string, MockOrder>();

  get(orderId: string): Promise<MockOrder | undefined> {
    const order = this.orders.get(orderId);
    return Promise.resolve(order ? { ...order } : undefined);
  }

  save(order: MockOrder): Promise<void> {
    this.orders.set(order.orderId, { ...order });
    return Promise.resolve();
  }
}

const MockEventSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  created_at: z.number().int(),
  data: z.object({
    order_id: z.string().min(1),
    payment_id: z.string().nullable(),
    amount_paise: z.number().int().nonnegative(),
  }),
});
type MockEvent = z.infer<typeof MockEventSchema>;

export function signMockPayload(secret: string, body: string): string {
  return `sha256=${hmacSha256(secret, body)}`;
}

export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  constructor(
    private readonly store: MockOrderStore,
    private readonly scheduleDelivery: (orderId: string, delayMs: number) => Promise<void>,
    private readonly config: MockConfig,
  ) {}

  async createOrder(input: CreateOrderInput): Promise<ProviderOrder> {
    const order: MockOrder = {
      orderId: `order_mock_${randomToken(12)}`,
      paymentId: input.paymentId,
      amountPaise: input.amountPaise,
      outcome: this.config.outcome,
      status: 'created',
      providerPaymentId: null,
      eventId: null,
      staleEventId: null,
    };
    await this.store.save(order);
    await this.scheduleDelivery(order.orderId, this.config.delayMs);
    return {
      orderId: order.orderId,
      checkout: { provider: 'mock', orderId: order.orderId, amountPaise: input.amountPaise, settlesInMs: this.config.delayMs },
    };
  }

  verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    const header = headers[MOCK_SIGNATURE_HEADER];
    return typeof header === 'string' && safeEqual(header, signMockPayload(this.config.secret, rawBody.toString('utf8')));
  }

  parseEvent(rawBody: Buffer): PaymentEvent | null {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidWebhookError('body is not JSON');
    }
    const parsed = MockEventSchema.safeParse(json);
    if (!parsed.success) throw new InvalidWebhookError('unexpected mock event shape');
    const evt = parsed.data;
    if (evt.type !== 'payment.captured' && evt.type !== 'payment.failed') return null;
    return {
      eventId: evt.id,
      orderId: evt.data.order_id,
      providerPaymentId: evt.data.payment_id,
      outcome: evt.type === 'payment.captured' ? 'captured' : 'failed',
      amountPaise: evt.data.amount_paise,
      raw: evt,
    };
  }

  async fetchOrderStatus(orderId: string): Promise<OrderStatus> {
    const order = await this.store.get(orderId);
    if (!order || order.status === 'created') return { status: 'pending' };
    if (order.status === 'failed') return { status: 'failed', raw: order };
    return { status: 'paid', providerPaymentId: order.providerPaymentId ?? '', amountPaise: order.amountPaise, raw: order };
  }

  refund(input: RefundInput): Promise<{ refundId: string }> {
    // Deterministic per idempotency key, so refunding the same payment twice yields one refund.
    return Promise.resolve({ refundId: `rfnd_mock_${input.idempotencyKey}` });
  }
}

export interface MockDeliveryDeps {
  store: MockOrderStore;
  config: MockConfig;
  /** POSTs a webhook body; resolves with the HTTP status. */
  post: (body: string, headers: Record<string, string>) => Promise<number>;
}

/**
 * Worker-side half of the mock gateway: settles the order (once; the result is stored so
 * a retried job re-sends identical events) and delivers the webhook(s).
 */
export async function deliverMockWebhooks(orderId: string, deps: MockDeliveryDeps): Promise<{ sent: number }> {
  const order = await deps.store.get(orderId);
  if (!order) {
    logger.warn({ orderId }, 'mock order not found; nothing to deliver');
    return { sent: 0 };
  }
  if (order.status === 'created') {
    order.status = order.outcome === 'success' ? 'paid' : 'failed';
    order.providerPaymentId = `pay_mock_${randomToken(12)}`;
    order.eventId = `evt_mock_${randomToken(12)}`;
    if (deps.config.outOfOrder) order.staleEventId = `evt_mock_${randomToken(12)}`;
    await deps.store.save(order);
  }
  if (deps.config.dropWebhooks) return { sent: 0 };

  const now = Math.floor(Date.now() / 1000);
  const primary: MockEvent = {
    id: order.eventId ?? '',
    type: order.status === 'paid' ? 'payment.captured' : 'payment.failed',
    created_at: now,
    data: { order_id: order.orderId, payment_id: order.providerPaymentId, amount_paise: order.amountPaise },
  };
  const events: MockEvent[] = [primary];
  for (let i = 0; i < deps.config.duplicates; i++) events.push(primary);
  if (order.staleEventId && order.status === 'paid') {
    // An earlier failed attempt whose webhook arrives AFTER the capture.
    events.push({ ...primary, id: order.staleEventId, type: 'payment.failed', created_at: now - 60 });
  }

  let sent = 0;
  for (const evt of events) {
    const body = JSON.stringify(evt);
    const status = await deps.post(body, {
      'content-type': 'application/json',
      [MOCK_SIGNATURE_HEADER]: signMockPayload(deps.config.secret, body),
    });
    // Like real gateways: retry on 5xx/network errors (throwing retries the job), give up on 4xx.
    if (status >= 500) throw new Error(`webhook delivery got HTTP ${status}`);
    if (status >= 400) {
      logger.warn({ orderId, status }, 'mock webhook rejected by the API');
      return { sent };
    }
    sent++;
  }
  return { sent };
}
