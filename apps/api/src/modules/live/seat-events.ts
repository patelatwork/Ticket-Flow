import { z } from 'zod';
import { onCommit, type TxClient } from '../../db/tx.js';
import { logger } from '../../lib/logger.js';

export const SEAT_STATES = ['AVAILABLE', 'HELD', 'SOLD'] as const;
export type LiveSeatState = (typeof SEAT_STATES)[number];

/**
 * A change to an event's seat map. `seats` carries absolute states (not deltas), so
 * applying a message twice, or a buffered message after a snapshot, converges.
 * `refresh` tells clients to refetch the snapshot (seats added/removed, event changed).
 */
export const SeatChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('seats'),
    eventId: z.uuid(),
    seats: z.array(z.object({ id: z.uuid(), state: z.enum(SEAT_STATES) })).min(1),
    at: z.iso.datetime(),
  }),
  z.object({ type: z.literal('refresh'), eventId: z.uuid(), at: z.iso.datetime() }),
]);
export type SeatChange = z.infer<typeof SeatChangeSchema>;

export type SeatChangeListener = (change: SeatChange) => void;

/** Fans seat changes out to this process's SSE clients. */
export interface SeatChangeBus {
  /** Called after commit by whichever process (API or worker) changed the seats. */
  publish(change: SeatChange): Promise<void>;
  /** Resolves once the subscription is live, so a snapshot read afterwards misses nothing. */
  subscribe(eventId: string, listener: SeatChangeListener): Promise<() => void>;
}

/** Single-process bus: the default (tests, and an API without Redis). */
export class LocalSeatChangeBus implements SeatChangeBus {
  private readonly listeners = new Map<string, Set<SeatChangeListener>>();

  publish(change: SeatChange): Promise<void> {
    this.deliver(change);
    return Promise.resolve();
  }

  subscribe(eventId: string, listener: SeatChangeListener): Promise<() => void> {
    let set = this.listeners.get(eventId);
    if (!set) {
      set = new Set();
      this.listeners.set(eventId, set);
    }
    set.add(listener);
    return Promise.resolve(() => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(eventId);
    });
  }

  /** Delivers to local listeners; also used by the Redis bus for messages it receives. */
  deliver(change: SeatChange): void {
    for (const listener of this.listeners.get(change.eventId) ?? []) {
      try {
        listener(change);
      } catch (err) {
        logger.warn({ err }, 'seat change listener failed');
      }
    }
  }

  hasListeners(eventId: string): boolean {
    return this.listeners.has(eventId);
  }
}

/** Side effects of a seat change besides the bus (e.g. cache invalidation). */
export type SeatChangeHook = (change: SeatChange) => Promise<void>;

let bus: SeatChangeBus = new LocalSeatChangeBus();
const hooks: SeatChangeHook[] = [];

export function setSeatChangeBus(next: SeatChangeBus): void {
  bus = next;
}

export function getSeatChangeBus(): SeatChangeBus {
  return bus;
}

export function addSeatChangeHook(hook: SeatChangeHook): void {
  hooks.push(hook);
}

async function emit(change: SeatChange): Promise<void> {
  // Hooks first: a client that reacts to the message must not refetch a stale cache.
  for (const hook of hooks) {
    try {
      await hook(change);
    } catch (err) {
      logger.warn({ err, eventId: change.eventId }, 'seat change hook failed');
    }
  }
  await bus.publish(change);
}

/**
 * Publishes after the transaction commits, never before: subscribers must not see a
 * state the database might still roll back. Best-effort by design. A lost message
 * is corrected on the client's next snapshot (reconnect), and cached seat maps expire
 * after a short TTL.
 */
export function publishSeatStatesAfterCommit(
  tx: TxClient,
  eventId: string,
  seats: { id: string; state: LiveSeatState }[],
): void {
  if (seats.length === 0) return;
  onCommit(tx, () => emit({ type: 'seats', eventId, seats, at: new Date().toISOString() }));
}

export function publishSeatMapRefreshAfterCommit(tx: TxClient, eventId: string): void {
  onCommit(tx, () => emit({ type: 'refresh', eventId, at: new Date().toISOString() }));
}

/** For changes made outside a transaction. */
export async function publishSeatMapRefresh(eventId: string): Promise<void> {
  try {
    await emit({ type: 'refresh', eventId, at: new Date().toISOString() });
  } catch (err) {
    logger.warn({ err, eventId }, 'seat map refresh publish failed');
  }
}
