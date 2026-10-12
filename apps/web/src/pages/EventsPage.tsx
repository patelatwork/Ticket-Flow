import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { EmptyState, ErrorState, LoadingState, PageTitle } from '../components/ui';
import { api } from '../lib/api';
import { dayAndMonth, formatDateTime } from '../lib/format';
import type { EventSummary } from '../lib/types';

export function EventsPage() {
  const events = useQuery({
    queryKey: ['events'],
    queryFn: ({ signal }) => api<{ events: EventSummary[] }>('/events?limit=50', { signal }),
  });

  return (
    <>
      <PageTitle sub="Pick your seats on the venue plan. We hold them for 10 minutes while you pay.">Upcoming events</PageTitle>
      {events.isPending ? (
        <LoadingState label="Loading events" />
      ) : events.isError ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : events.data.events.length === 0 ? (
        <EmptyState title="Nothing on sale right now">New events appear here as soon as organizers publish them.</EmptyState>
      ) : (
        <ol className="flex flex-col">
          {events.data.events.map((e) => {
            const { day, month } = dayAndMonth(e.startsAt);
            return (
              <li key={e.id} className="border-t border-rule last:border-b">
                <Link to={`/events/${e.id}`} className="group grid grid-cols-[auto_1fr] items-center gap-x-3 py-2">
                  <span className="w-8 flex flex-col items-center leading-none" aria-hidden>
                    <span className="font-display font-extrabold text-2xl md:text-3xl">{day}</span>
                    <span className="text-sm text-ink-soft">{month}</span>
                  </span>
                  <span className="flex flex-col gap-1 min-w-0">
                    <span className="font-display font-bold text-lg md:text-xl group-hover:text-accent">{e.title}</span>
                    <span className="text-sm text-ink-soft">
                      {e.venue}, {formatDateTime(e.startsAt)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
