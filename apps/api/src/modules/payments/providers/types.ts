import type { IncomingHttpHeaders } from 'node:http';

export const PROVIDER_NAMES = ['mock', 'razorpay'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface CreateOrderInput {
  /** Our payment id; used as the provider-side receipt so orders can be traced back. */
  paymentId: string;
  bookingId: string;
  amountPaise: number;
}

export interface ProviderOrder {
  orderId: string;
  /** Opaque data the browser needs to open the provider's checkout. */
  checkout: Record<string, unknown>;
}

/** A provider webhook (or reconciliation result) normalized to what we act on. */
export interface PaymentEvent {
  eventId: string;
  orderId: string;
  providerPaymentId: string | null;
  outcome: 'captured' | 'failed';
  amountPaise: number;
  raw: unknown;
}

export type OrderStatus =
  | { status: 'paid'; providerPaymentId: string; amountPaise: number; raw: unknown }
  | { status: 'failed'; raw: unknown }
  | { status: 'pending' };

export interface RefundInput {
  providerPaymentId: string;
  amountPaise: number;
  /** Stable per payment: the provider (or our pre-check) uses it to avoid double refunds. */
  idempotencyKey: string;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  createOrder(input: CreateOrderInput): Promise<ProviderOrder>;
  /** Constant-time signature check over the exact raw request body. */
  verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  /** Returns null for event types we deliberately ignore. Throws on malformed payloads. */
  parseEvent(rawBody: Buffer, headers: IncomingHttpHeaders): PaymentEvent | null;
  fetchOrderStatus(orderId: string): Promise<OrderStatus>;
  refund(input: RefundInput): Promise<{ refundId: string }>;
}

export class InvalidWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWebhookError';
  }
}
