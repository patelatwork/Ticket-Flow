import type { Job } from 'bullmq';
import { AppError } from '../../lib/errors.js';
import { DeadLetterJobSchema, JOBS, jobId, type DeadLetterJob, type JobName, type QueueName } from '../../queues/definitions.js';
import type { QueueRegistry } from '../../queues/queues.js';

export interface DeadLetterDto extends DeadLetterJob {
  id: string;
}

function isJobName(name: string): name is JobName {
  return Object.hasOwn(JOBS, name);
}

/**
 * Records a job that exhausted its retries. The DLQ is a plain queue with no worker:
 * entries wait there for an operator to inspect, fix the cause, and retry.
 */
export async function moveToDeadLetter(queues: QueueRegistry, job: Job, queue: QueueName, reason: string): Promise<void> {
  const entry: DeadLetterJob = {
    queue,
    jobName: job.name,
    jobId: job.id ?? 'unknown',
    data: job.data as unknown,
    failedReason: reason.slice(0, 2000),
    attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
  };
  // Deterministic id: if the 'failed' handler runs twice for the same final failure, one entry.
  await queues.add('dead-letter', entry, { jobId: jobId('dlq', queue, entry.jobId, String(job.attemptsMade)) });
}

export async function listDeadLetters(queues: QueueRegistry, limit: number): Promise<DeadLetterDto[]> {
  const jobs = await queues.get('dlq').getJobs(['waiting', 'prioritized', 'delayed'], 0, limit - 1);
  const out: DeadLetterDto[] = [];
  for (const job of jobs) {
    const parsed = DeadLetterJobSchema.safeParse(job.data);
    if (parsed.success && job.id) out.push({ id: job.id, ...parsed.data });
  }
  return out;
}

/**
 * Re-enqueues the original job (re-validated against its schema) under a fresh job id,
 * then removes the DLQ entry. Handlers are idempotent, so retrying a job whose effect
 * partially happened is safe.
 */
export async function retryDeadLetter(queues: QueueRegistry, dlqJobId: string): Promise<{ requeuedAs: string }> {
  const job = await queues.get('dlq').getJob(dlqJobId);
  if (!job) throw AppError.notFound('Dead-letter job');
  const entry = DeadLetterJobSchema.parse(job.data);
  if (!isJobName(entry.jobName) || JOBS[entry.jobName].queue !== entry.queue) {
    throw AppError.unprocessable('UNKNOWN_JOB', `Cannot retry job "${entry.jobName}" on queue "${entry.queue}"`);
  }
  const data: unknown = JOBS[entry.jobName].schema.parse(entry.data);
  const newId = jobId(entry.jobId, 'retry', String(Date.now()));
  await queues.get(entry.queue).add(entry.jobName, data, { jobId: newId });
  await job.remove();
  return { requeuedAs: newId };
}
