import type { Redis } from 'ioredis';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type { SeatMapDto } from './events.service.js';

/**
 * Cache for the public seat map: the hottest read in the system during an on-sale.
 * Correctness never depends on it. Booking always locks and re-checks seats in Postgres,
 * so a stale cache entry can at worst show a seat as free that then returns 409.
 */
export interface CacheRead {
  value?: SeatMapDto;
  /** Generation observed at read time; a write is dropped if it changed since. */
  generation: string;
}

export interface SeatMapCache {
  get(eventId: string): Promise<CacheRead>;
  set(eventId: string, value: SeatMapDto, generation: string): Promise<void>;
  invalidate(eventId: string): Promise<void>;
}

class NoopSeatMapCache implements SeatMapCache {
  get(): Promise<CacheRead> {
    return Promise.resolve({ generation: '0' });
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
  invalidate(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * SET only if the generation is unchanged. Closes the classic race: reader misses, reads
 * the DB, a writer commits + invalidates, the reader then caches its stale result.
 */
const SET_IF_GENERATION = `
local current = redis.call('GET', KEYS[2]) or '0'
if current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
  return 1
end
return 0`;

const CachedSeatMapSchema = z.object({
  event: z.object({
    id: z.string(),
    organizerId: z.string(),
    title: z.string(),
    description: z.string(),
    venue: z.string(),
    startsAt: z.string(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'CANCELLED']),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  seats: z.array(
    z.object({ id: z.string(), label: z.string(), tier: z.string(), pricePaise: z.number(), state: z.enum(['AVAILABLE', 'HELD', 'SOLD']) }),
  ),
});

/**
 * Redis-backed. Every operation degrades to "cache miss" on Redis errors (outage = slower,
 * never broken). The TTL also bounds how long a lapsed-but-unexpired hold shows as HELD.
 */
export class RedisSeatMapCache implements SeatMapCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = env.SEAT_MAP_CACHE_TTL_SECONDS,
  ) {}

  private key(eventId: string): string {
    return `cache:seatmap:${eventId}`;
  }

  private genKey(eventId: string): string {
    return `cache:seatmap:gen:${eventId}`;
  }

  async get(eventId: string): Promise<CacheRead> {
    try {
      const [raw, generation] = await this.redis.mget(this.key(eventId), this.genKey(eventId));
      const gen = generation ?? '0';
      if (raw === null || raw === undefined) return { generation: gen };
      const parsed = CachedSeatMapSchema.safeParse(JSON.parse(raw));
      return parsed.success ? { value: parsed.data, generation: gen } : { generation: gen };
    } catch (err) {
      logger.debug({ err }, 'seat map cache get failed');
      // Unknown generation: the conditional set below will never match it.
      return { generation: 'unavailable' };
    }
  }

  async set(eventId: string, value: SeatMapDto, generation: string): Promise<void> {
    try {
      await this.redis.eval(SET_IF_GENERATION, 2, this.key(eventId), this.genKey(eventId), generation, JSON.stringify(value), String(this.ttlSeconds));
    } catch (err) {
      logger.debug({ err }, 'seat map cache set failed');
    }
  }

  async invalidate(eventId: string): Promise<void> {
    await this.redis.multi().incr(this.genKey(eventId)).expire(this.genKey(eventId), 7 * 24 * 3600).del(this.key(eventId)).exec();
  }
}

let cache: SeatMapCache = new NoopSeatMapCache();

export function setSeatMapCache(next: SeatMapCache): void {
  cache = next;
}

export function getSeatMapCache(): SeatMapCache {
  return cache;
}
