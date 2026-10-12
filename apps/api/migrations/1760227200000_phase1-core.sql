-- Up Migration

CREATE TYPE user_role AS ENUM ('attendee', 'organizer', 'admin');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'attendee',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- Refresh tokens are stored hashed and rotated on every use. All tokens descended
-- from one login share a family_id so reuse of a rotated token revokes the family.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TYPE event_status AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES users (id),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description  text NOT NULL DEFAULT '',
  venue        text NOT NULL CHECK (char_length(venue) BETWEEN 1 AND 200),
  starts_at    timestamptz NOT NULL,
  status       event_status NOT NULL DEFAULT 'DRAFT',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_published_starts_at_idx ON events (starts_at) WHERE status = 'PUBLISHED';
CREATE INDEX events_organizer_idx ON events (organizer_id, starts_at);

CREATE TABLE seats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 20),
  tier        text NOT NULL CHECK (char_length(tier) BETWEEN 1 AND 40),
  price_paise integer NOT NULL CHECK (price_paise > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seats_event_label_key UNIQUE (event_id, label),
  -- Target for the composite FK from booking_seats: a seat can only be booked for its own event.
  CONSTRAINT seats_id_event_key UNIQUE (id, event_id)
);

CREATE TYPE booking_status AS ENUM ('HELD', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED');

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id),
  event_id        uuid NOT NULL REFERENCES events (id),
  status          booking_status NOT NULL DEFAULT 'HELD',
  hold_expires_at timestamptz NOT NULL,
  total_paise     integer NOT NULL CHECK (total_paise >= 0),
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_user_idempotency_key UNIQUE (user_id, idempotency_key),
  CONSTRAINT bookings_id_event_key UNIQUE (id, event_id)
);
CREATE INDEX bookings_user_created_idx ON bookings (user_id, created_at DESC);
CREATE INDEX bookings_held_expiry_idx ON bookings (hold_expires_at) WHERE status = 'HELD';

-- is_active mirrors "booking.status IN ('HELD','PAID')". It is denormalized because a
-- partial unique index can only reference columns of its own table. It is written
-- only by the booking state-transition function, in the same transaction as the
-- status change (see docs/architecture.md).
CREATE TABLE booking_seats (
  booking_id uuid NOT NULL,
  seat_id    uuid NOT NULL,
  event_id   uuid NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (booking_id, seat_id),
  FOREIGN KEY (booking_id, event_id) REFERENCES bookings (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (seat_id, event_id) REFERENCES seats (id, event_id)
);
CREATE INDEX booking_seats_seat_idx ON booking_seats (seat_id);

-- The core invariant: at most one active (HELD or PAID) booking per seat.
CREATE UNIQUE INDEX booking_seats_one_active_per_seat
  ON booking_seats (event_id, seat_id)
  WHERE is_active;

-- Stored responses for idempotent endpoints, scoped per user.
CREATE TABLE idempotency_keys (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Down Migration

DROP TABLE idempotency_keys;
DROP TABLE booking_seats;
DROP TABLE bookings;
DROP TYPE booking_status;
DROP TABLE seats;
DROP TABLE events;
DROP TYPE event_status;
DROP TABLE refresh_tokens;
DROP TABLE users;
DROP TYPE user_role;
