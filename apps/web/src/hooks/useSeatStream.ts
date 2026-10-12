import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SeatMap, SeatStreamMessage } from '../lib/types';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

export const seatMapKey = (eventId: string) => ['seat-map', eventId] as const;

/**
 * Keeps the seat-map query live via SSE. Every (re)connect delivers a full snapshot, which
 * replaces the cache, so missed messages during a disconnect can't leave stale seats.
 * Later messages patch individual seats in place.
 */
export function useSeatStream(eventId: string | undefined): StreamStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    if (!eventId) return;
    const source = new EventSource(`/api/events/${eventId}/seats/stream`);

    source.addEventListener('snapshot', (e) => {
      queryClient.setQueryData<SeatMap>(seatMapKey(eventId), JSON.parse((e as MessageEvent<string>).data) as SeatMap);
      setStatus('live');
    });
    source.addEventListener('seats', (e) => {
      const msg = JSON.parse((e as MessageEvent<string>).data) as SeatStreamMessage;
      if (msg.type !== 'seats') return;
      const states = new Map(msg.seats.map((s) => [s.id, s.state]));
      queryClient.setQueryData<SeatMap>(seatMapKey(eventId), (prev) =>
        prev ? { ...prev, seats: prev.seats.map((s) => ({ ...s, state: states.get(s.id) ?? s.state })) } : prev,
      );
    });
    source.addEventListener('refresh', () => {
      void queryClient.invalidateQueries({ queryKey: seatMapKey(eventId) });
    });
    source.onerror = () => {
      // EventSource retries on its own; the next snapshot resynchronizes.
      setStatus('reconnecting');
    };

    return () => {
      source.close();
    };
  }, [eventId, queryClient]);

  return status;
}
