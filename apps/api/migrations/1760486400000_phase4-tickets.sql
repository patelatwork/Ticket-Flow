-- Up Migration

CREATE TABLE tickets (
  id         uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings (id),
  seat_id    uuid NOT NULL REFERENCES seats (id),
  qr_token   text NOT NULL,
  pdf_key    text,
  used_at    timestamptz,
  used_by    uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Re-running ticket generation can never mint a second ticket for a seat.
  CONSTRAINT tickets_booking_seat_key UNIQUE (booking_id, seat_id)
);
CREATE UNIQUE INDEX tickets_qr_token_key ON tickets (qr_token);

-- Outgoing notifications, deduplicated by a deterministic key (e.g. tickets-ready:<booking>).
CREATE TABLE notifications (
  dedupe_key text PRIMARY KEY,
  kind       text NOT NULL,
  recipient  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

-- One row per organizer per UTC day; regenerated idempotently by upsert.
CREATE TABLE reports (
  organizer_id   uuid NOT NULL REFERENCES users (id),
  report_date    date NOT NULL,
  bookings_paid  integer NOT NULL,
  tickets_sold   integer NOT NULL,
  gross_paise    bigint NOT NULL,
  refunded_paise bigint NOT NULL,
  by_event       jsonb NOT NULL,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organizer_id, report_date)
);

-- Down Migration

DROP TABLE reports;
DROP TABLE notifications;
DROP TABLE tickets;
