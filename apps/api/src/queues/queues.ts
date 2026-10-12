import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { DEFAULT_JOB_OPTIONS, JOBS, QUEUE_NAMES, WORKER_CONFIG, type JobData, type JobName, type QueueName } from './definitions.js';

/**
 * Lazily creates one Queue per name on a shared producer connection. Producers never
 * block, so all queues can share one connection.
 */
export class QueueRegistry {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly connection: Redis) {}

  get(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        prefix: env.QUEUE_PREFIX,
        defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...WORKER_CONFIG[name].jobOptions },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  all(): Queue[] {
    return QUEUE_NAMES.map((n) => this.get(n));
  }

  /** Validates the payload against the job's schema before it reaches Redis. */
  async add<N extends JobName>(name: N, data: JobData<N>, opts: JobsOptions = {}): Promise<void> {
    const def = JOBS[name];
    const payload: unknown = def.schema.parse(data);
    await this.get(def.queue).add(name, payload, opts);
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
