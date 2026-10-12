import type { Redis } from 'ioredis';
import { logger } from '../../lib/logger.js';
import { LocalSeatChangeBus, SeatChangeSchema, type SeatChange, type SeatChangeBus, type SeatChangeListener } from './seat-events.js';

const CHANNEL_PREFIX = 'seats:';

/**
 * Cross-instance fan-out. Every process publishes to `seats:<eventId>`; each API instance
 * holds ONE subscriber connection and subscribes to a channel only while it has SSE
 * clients for that event, then delivers to them through a local bus.
 */
export class RedisSeatChangeBus implements SeatChangeBus {
  private readonly local = new LocalSeatChangeBus();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber?: Redis,
  ) {
    subscriber?.on('message', (channel: string, message: string) => {
      if (!channel.startsWith(CHANNEL_PREFIX)) return;
      let json: unknown;
      try {
        json = JSON.parse(message);
      } catch {
        logger.warn({ channel }, 'malformed seat change message');
        return;
      }
      const parsed = SeatChangeSchema.safeParse(json);
      if (parsed.success) this.local.deliver(parsed.data);
      else logger.warn({ channel }, 'invalid seat change message');
    });
  }

  async publish(change: SeatChange): Promise<void> {
    await this.publisher.publish(CHANNEL_PREFIX + change.eventId, JSON.stringify(change));
  }

  async subscribe(eventId: string, listener: SeatChangeListener): Promise<() => void> {
    const { subscriber } = this;
    if (!subscriber) throw new Error('RedisSeatChangeBus was created without a subscriber connection');
    const channel = CHANNEL_PREFIX + eventId;
    const first = !this.local.hasListeners(eventId);
    const unsubscribeLocal = await this.local.subscribe(eventId, listener);
    if (first) this.pending.set(channel, subscriber.subscribe(channel));
    // Every subscriber waits for the channel subscription, including later ones that race it.
    await this.pending.get(channel);

    return () => {
      unsubscribeLocal();
      if (!this.local.hasListeners(eventId)) {
        this.pending.delete(channel);
        subscriber.unsubscribe(channel).catch((err: unknown) => {
          logger.warn({ err, channel }, 'redis unsubscribe failed');
        });
      }
    };
  }
}
