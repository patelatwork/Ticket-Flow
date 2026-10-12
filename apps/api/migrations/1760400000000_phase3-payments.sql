-- Up Migration

-- PENDING         order created at the provider, outcome unknown
-- SUCCEEDED       captured and applied: the booking is PAID by this payment
-- FAILED          provider reported failure (or it was abandoned); booking untouched
-- REFUND_PENDING  money was captured but cannot be applied (late payment, seats gone,
--                 cancelled booking/event, double payment); a refund job is queued
-- REFUNDED        refund confirmed by the provider
CREATE TYPE payment_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUND_PENDING', 'REFUNDED');

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          uuid NOT NULL REFERENCES bookings (id),
  provider            text NOT NULL,
  provider_order_id   text,
  provider_payment_id text,
  -- The provider event that settled this payment (captured/failed).
  provider_event_id   text,
  status              payment_status NOT NULL DEFAULT 'PENDING',
  amount_paise        integer NOT NULL CHECK (amount_paise > 0),
  currency            text NOT NULL DEFAULT 'INR',
  checkout            jsonb,
  refund_reason       text,
  provider_refund_id  text,
  raw                 jsonb,
  -- Set once when the payment is applied to a booking / when the refund is confirmed (reports).
  succeeded_at        timestamptz,
  refunded_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_provider_order_key UNIQUE (provider, provider_order_id),
  CONSTRAINT payments_provider_event_key UNIQUE (provider, provider_event_id)
);
CREATE INDEX payments_booking_idx ON payments (booking_id);
-- At most one in-flight order per booking: repeated "pay" calls reuse it.
CREATE UNIQUE INDEX payments_one_pending_per_booking ON payments (booking_id) WHERE status = 'PENDING';
CREATE INDEX payments_pending_created_idx ON payments (created_at) WHERE status = 'PENDING';
CREATE INDEX payments_succeeded_at_idx ON payments (succeeded_at) WHERE succeeded_at IS NOT NULL;
CREATE INDEX payments_refunded_at_idx ON payments (refunded_at) WHERE refunded_at IS NOT NULL;

-- Every webhook/reconciliation event ever applied. The primary key is the dedupe:
-- a duplicate delivery hits ON CONFLICT DO NOTHING inside the applying transaction.
CREATE TABLE payment_events (
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  payment_id        uuid REFERENCES payments (id),
  event_type        text NOT NULL,
  result            text,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id)
);

-- Down Migration

DROP TABLE payment_events;
DROP TABLE payments;
DROP TYPE payment_status;
