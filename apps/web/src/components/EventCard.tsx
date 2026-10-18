import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { seatMapKey } from '../hooks/useSeatStream';
import { api } from '../lib/api';
import { dayAndMonth, formatDateTime, formatPaise } from '../lib/format';
import type { EventSummary, SeatMap } from '../lib/types';

export interface Availability {
  total: number;
  available: number;
  fromPaise: number | null;
}

/** Seat counts and the cheapest open seat, from the (shared, cached) seat map query. */
export function useAvailability(eventId: string) {
  return useQuery({
    queryKey: seatMapKey(eventId),
    queryFn: ({ signal }) => api<SeatMap>(`/events/${eventId}/seats`, { signal }),
    select: (map): Availability => {
      const open = map.seats.filter((s) => s.state === 'AVAILABLE');
      return {
        total: map.seats.length,
        available: open.length,
        fromPaise: open.length > 0 ? Math.min(...open.map((s) => s.pricePaise)) : null,
      };
    },
  });
}

function AvailabilityLine({ eventId }: { eventId: string }) {
  const availability = useAvailability(eventId);
  if (availability.isPending) return <span className="text-sm text-muted">Checking seats…</span>;
  // The card still works without counts; the event page shows the full map.
  if (availability.isError) return <span className="text-sm text-muted">See seats</span>;
  const { total, available, fromPaise } = availability.data;
  if (available === 0) return <span className="text-sm font-bold text-ink-soft">Sold out</span>;
  const scarce = available / total <= 0.2;
  return (
    <span className="flex flex-wrap items-center gap-x-1 text-sm">
      {fromPaise !== null && <span className="font-bold">From {formatPaise(fromPaise)}</span>}
      <span className="text-ink-soft">
        · {available} of {total} left
      </span>
      {scarce && (
        <span className="inline-flex items-center gap-px px-1 rounded-sm border border-accent bg-accent-wash text-accent-deep text-xs font-bold">
          <span aria-hidden>▲</span> Selling fast
        </span>
      )}
    </span>
  );
}

/** A ticket-stub card: date on the stub, details on the body, perforation between. */
export function EventCard({ event }: { event: EventSummary }) {
  const { day, month } = dayAndMonth(event.startsAt);
  return (
    <Link
      to={`/events/${event.id}`}
      className="stub group grid grid-cols-[auto_1fr] bg-surface border border-rule rounded-lg hover:border-ink transition-colors"
    >
      <span aria-hidden className="flex flex-col items-center justify-center px-2 py-2 border-r border-dashed border-rule leading-none">
        <span className="font-display font-extrabold text-2xl">{day}</span>
        <span className="text-sm text-ink-soft uppercase">{month}</span>
      </span>
      <span className="flex flex-col gap-1 p-2 min-w-0">
        <span className="font-display font-bold text-lg leading-tight group-hover:text-accent">{event.title}</span>
        <span className="text-sm text-ink-soft">
          {event.venue}
          <span className="block">{formatDateTime(event.startsAt)}</span>
        </span>
        <AvailabilityLine eventId={event.id} />
      </span>
    </Link>
  );
}
