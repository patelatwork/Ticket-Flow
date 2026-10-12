import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import type { z } from 'zod';
import { logger } from '../lib/logger.js';
import { expireHold } from '../modules/bookings/hold-expiry.service.js';
import { sendNotification } from '../modules/notifications/notifications.service.js';
import { processRefund, reconcilePendingPayments } from '../modules/payments/payments.service.js';
import { deliverMockWebhooks, type MockDeliveryDeps } from '../modules/payments/providers/mock.js';
import { generateDailySalesReport, listReportableOrganizers, yesterdayUtc } from '../modules/reports/reports.service.js';
import { generateTickets } from '../modules/tickets/tickets.service.js';
import { JOBS, jobId, type JobData, type JobName, type QueueName } from '../queues/definitions.js';
import type { QueueRegistry } from '../queues/queues.js';

export interface ProcessorDeps {
  queues: QueueRegistry;
  mockDelivery: MockDeliveryDeps;
}

function isJobName(name: string): name is JobName {
  return Object.hasOwn(JOBS, name);
}

/**
 * Redis contents are external input: re-validate every payload. A malformed payload will
 * never succeed, so it fails immediately (UnrecoverableError) and goes to the DLQ instead
 * of burning retries.
 */
function payload<N extends JobName>(name: N, job: Job): JobData<N> {
  const schema: z.ZodType = JOBS[name].schema;
  const parsed = schema.safeParse(job.data);
  if (!parsed.success) throw new UnrecoverableError(`invalid payload for ${name}: ${parsed.error.message}`);
  return parsed.data as JobData<N>;
}

/** Every handler called here is idempotent; see each service for how. */
export function createProcessor(queue: QueueName, deps: ProcessorDeps) {
  return async (job: Job, token?: string): Promise<unknown> => {
    const { name } = job;
    if (!isJobName(name) || JOBS[name].queue !== queue) throw new UnrecoverableError(`unknown job "${name}" on queue "${queue}"`);

    switch (name) {
      case 'hold-expiry': {
        const outcome = await expireHold(payload(name, job).bookingId);
        if (outcome.result === 'not-due') {
          // Fired early (clock skew): park it until it's due without consuming an attempt.
          await job.moveToDelayed(Date.now() + outcome.retryInMs, token);
          throw new DelayedError();
        }
        return outcome;
      }
      case 'refund':
        return { result: await processRefund(payload(name, job).paymentId) };
      case 'payment-reconciliation': {
        const summary = await reconcilePendingPayments();
        if (summary.checked > 0) logger.info({ summary }, 'payment reconciliation');
        return summary;
      }
      case 'deliver-webhook':
        return deliverMockWebhooks(payload(name, job).orderId, deps.mockDelivery);
      case 'generate-tickets':
        return generateTickets(payload(name, job).bookingId);
      case 'send-notification':
        return { result: await sendNotification(payload(name, job)) };
      case 'daily-sales-report-fanout': {
        // One job per organizer, deduped per (organizer, day) by job id.
        const reportDate = payload(name, job).reportDate ?? yesterdayUtc();
        const organizers = await listReportableOrganizers();
        for (const organizerId of organizers) {
          await deps.queues.add('daily-sales-report', { organizerId, reportDate }, { jobId: jobId('sales-report', organizerId, reportDate) });
        }
        return { organizers: organizers.length, reportDate };
      }
      case 'daily-sales-report': {
        const { organizerId, reportDate } = payload(name, job);
        return generateDailySalesReport(organizerId, reportDate);
      }
      case 'dead-letter':
        throw new UnrecoverableError('dead letters are not processed automatically');
    }
  };
}
