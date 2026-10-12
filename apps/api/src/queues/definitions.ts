import type { DefaultJobOptions, RateLimiterOptions } from 'bullmq';
import { z } from 'zod';

/**
 * Every queue, its jobs and their payload schemas. Payloads are validated when a job is
 * created (outbox write / direct add) AND when it is processed, because Redis contents
 * are external input like any other.
 */
export const QUEUE_NAMES = ['hold-expiry', 'payments', 'mock-provider', 'tickets', 'notifications', 'reports', 'dlq'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const HoldExpiryJobSchema = z.object({ bookingId: z.uuid() });
export const RefundJobSchema = z.object({ paymentId: z.uuid() });
export const ReconciliationJobSchema = z.object({}).loose();
export const MockDeliveryJobSchema = z.object({ orderId: z.string().min(1) });
export const GenerateTicketsJobSchema = z.object({ bookingId: z.uuid() });
export const NotificationJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tickets-ready'), bookingId: z.uuid() }),
  z.object({ kind: z.literal('refund-issued'), paymentId: z.uuid() }),
]);
export type NotificationJob = z.infer<typeof NotificationJobSchema>;
export const SalesReportFanoutJobSchema = z.object({ reportDate: z.iso.date().optional() }).loose();
export const SalesReportJobSchema = z.object({ organizerId: z.uuid(), reportDate: z.iso.date() });
export const DeadLetterJobSchema = z.object({
  queue: z.enum(QUEUE_NAMES),
  jobName: z.string(),
  jobId: z.string(),
  data: z.unknown(),
  failedReason: z.string(),
  attemptsMade: z.number().int(),
  failedAt: z.iso.datetime(),
});
export type DeadLetterJob = z.infer<typeof DeadLetterJobSchema>;

/** (queue, job name) -> payload schema. Workers dispatch on job.name. */
export const JOBS = {
  'hold-expiry': { queue: 'hold-expiry', schema: HoldExpiryJobSchema },
  refund: { queue: 'payments', schema: RefundJobSchema },
  'payment-reconciliation': { queue: 'payments', schema: ReconciliationJobSchema },
  'deliver-webhook': { queue: 'mock-provider', schema: MockDeliveryJobSchema },
  'generate-tickets': { queue: 'tickets', schema: GenerateTicketsJobSchema },
  'send-notification': { queue: 'notifications', schema: NotificationJobSchema },
  'daily-sales-report-fanout': { queue: 'reports', schema: SalesReportFanoutJobSchema },
  'daily-sales-report': { queue: 'reports', schema: SalesReportJobSchema },
  'dead-letter': { queue: 'dlq', schema: DeadLetterJobSchema },
} as const satisfies Record<string, { queue: QueueName; schema: z.ZodType }>;

export type JobName = keyof typeof JOBS;
export type JobData<N extends JobName> = z.infer<(typeof JOBS)[N]['schema']>;

/** Jobs that may be written to the outbox (i.e. are triggered by a DB state change). */
export const OUTBOX_JOBS = ['hold-expiry', 'refund', 'generate-tickets', 'send-notification'] as const satisfies readonly JobName[];
export type OutboxJobName = (typeof OUTBOX_JOBS)[number];

/**
 * BullMQ custom job ids may not contain ':' and must not be integers, so ids are built
 * from '_'-joined parts. One deterministic id per logical job gives queue-level dedupe
 * on top of handler idempotency.
 */
export function jobId(...parts: string[]): string {
  return parts.map((p) => p.replaceAll(':', '-')).join('_');
}

export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 6,
  // 1s, 2s, 4s, 8s, 16s (+/- 50% jitter so retries from a burst of failures spread out).
  backoff: { type: 'exponential', delay: 1_000, jitter: 0.5 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  // Failed jobs are kept for a week for inspection; the DLQ keeps its own copy.
  removeOnFail: { age: 7 * 24 * 3600, count: 20_000 },
};

export interface WorkerConfig {
  concurrency: number;
  limiter?: RateLimiterOptions;
  /** Overrides DEFAULT_JOB_OPTIONS for jobs added to this queue. */
  jobOptions?: DefaultJobOptions;
}

export const WORKER_CONFIG: Record<QueueName, WorkerConfig> = {
  // Cheap DB-only transitions; many can run in parallel.
  'hold-expiry': { concurrency: 20 },
  // Provider API calls: bounded so a reconciliation sweep can't hammer the provider.
  payments: { concurrency: 5, limiter: { max: 20, duration: 1_000 } },
  'mock-provider': { concurrency: 10 },
  // CPU-bound PDF rendering.
  tickets: { concurrency: 4 },
  // SMTP providers rate-limit; stay well under.
  notifications: { concurrency: 5, limiter: { max: 10, duration: 1_000 } },
  reports: { concurrency: 2 },
  // Dead letters are parked, never processed automatically.
  dlq: { concurrency: 1, jobOptions: { attempts: 1, removeOnComplete: false, removeOnFail: false } },
};
