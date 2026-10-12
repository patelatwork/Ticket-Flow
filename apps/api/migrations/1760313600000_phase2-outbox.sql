-- Up Migration

-- Transactional outbox. A row is written in the same transaction as the state change
-- that requires a job; the relay (worker process) moves it to BullMQ afterwards.
-- Rows are claimed with a lease (claimed_until) rather than held under a row lock while
-- enqueuing, so no network I/O ever happens inside a transaction.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  -- BullMQ job id: a repeated dispatch of the same row is deduplicated by the queue.
  job_id        text NOT NULL,
  -- Earliest time the job should run (delayed jobs, e.g. hold expiry). NULL = now.
  run_at        timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  dispatched_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (id) WHERE dispatched_at IS NULL;
CREATE INDEX outbox_dispatched_at_idx ON outbox (dispatched_at) WHERE dispatched_at IS NOT NULL;

-- Down Migration

DROP TABLE outbox;
