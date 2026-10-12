import type { Redis } from 'ioredis';
import { getObjectStorage, S3ObjectStorage, setObjectStorage } from './lib/storage.js';
import { logger } from './lib/logger.js';
import { RedisSeatMapCache, setSeatMapCache } from './modules/events/seat-map-cache.js';
import { RedisSeatChangeBus } from './modules/live/redis-seat-bus.js';
import { addSeatChangeHook, setSeatChangeBus } from './modules/live/seat-events.js';
import { RedisMockOrderStore } from './modules/payments/providers/mock.js';
import { configurePaymentProviders } from './modules/payments/providers/registry.js';
import { createRedis } from './queues/connection.js';
import { jobId } from './queues/definitions.js';
import { QueueRegistry } from './queues/queues.js';

export interface Runtime {
  redis: Redis;
  queues: QueueRegistry;
  mockStore: RedisMockOrderStore;
  close(): Promise<void>;
}

/**
 * Production wiring shared by the API and the worker: Redis connections, queues, payment
 * providers, the seat-change bus + cache invalidation, and object storage. Tests skip
 * this and use the in-memory defaults.
 */
export function createRuntime(opts: { subscriber: boolean }): Runtime {
  const redis = createRedis('client');
  const subscriber = opts.subscriber ? createRedis('subscriber') : undefined;
  const queues = new QueueRegistry(redis);

  const mockStore = new RedisMockOrderStore(redis);
  configurePaymentProviders({
    mockStore,
    // The mock gateway "calls back later": a delayed job in the worker posts the webhook.
    scheduleMockDelivery: (orderId, delayMs) =>
      queues.add('deliver-webhook', { orderId }, { delay: delayMs, jobId: jobId('mock-deliver', orderId) }),
  });

  const cache = new RedisSeatMapCache(redis);
  setSeatMapCache(cache);
  addSeatChangeHook((change) => cache.invalidate(change.eventId));
  setSeatChangeBus(new RedisSeatChangeBus(redis, subscriber));

  setObjectStorage(new S3ObjectStorage());

  return {
    redis,
    queues,
    mockStore,
    async close() {
      await queues.close();
      await Promise.allSettled([redis.quit(), subscriber?.quit()]);
    },
  };
}

/** MinIO may start after us; retry bucket creation in the background instead of failing boot. */
export function ensureBucketInBackground(): void {
  const attempt = (n: number): void => {
    getObjectStorage()
      .ensureBucket()
      .then(() => {
        logger.info('object storage bucket ready');
      })
      .catch((err: unknown) => {
        if (n >= 10) {
          logger.error({ err }, 'object storage bucket unavailable; ticket uploads will retry via job backoff');
          return;
        }
        setTimeout(() => {
          attempt(n + 1);
        }, Math.min(30_000, 1_000 * 2 ** n)).unref();
      });
  };
  attempt(0);
}
