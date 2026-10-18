import { useQuery } from '@tanstack/react-query';
import { useId, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { EventCard } from '../components/EventCard';
import { Button, EmptyState, ErrorState, LoadingState, PageTitle } from '../components/ui';
import { api } from '../lib/api';
import type { EventSummary } from '../lib/types';

type When = 'all' | 'week' | 'month' | 'later';

const WHEN_LABELS: Record<When, string> = { all: 'Any date', week: 'Next 7 days', month: 'Next 30 days', later: 'Later' };
const DAY = 86_400_000;

function matchesWhen(startsAt: string, when: When, now: number): boolean {
  const t = Date.parse(startsAt) - now;
  if (when === 'week') return t <= 7 * DAY;
  if (when === 'month') return t <= 30 * DAY;
  if (when === 'later') return t > 30 * DAY;
  return true;
}

export function EventsPage() {
  const events = useQuery({
    queryKey: ['events'],
    queryFn: ({ signal }) => api<{ events: EventSummary[] }>('/events?limit=50', { signal }),
  });
  // Filters live in the URL, so a filtered list can be shared or bookmarked.
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const whenParam = params.get('when');
  const when: When = whenParam === 'week' || whenParam === 'month' || whenParam === 'later' ? whenParam : 'all';
  const searchId = useId();

  function update(key: 'q' | 'when', value: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === '' || value === 'all') next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const now = Date.now();
    return (events.data?.events ?? []).filter(
      (e) => matchesWhen(e.startsAt, when, now) && (needle === '' || `${e.title} ${e.venue}`.toLowerCase().includes(needle)),
    );
  }, [events.data, q, when]);

  return (
    <>
      <PageTitle sub="Pick your seats on the venue plan. We hold them for 10 minutes while you pay.">Upcoming events</PageTitle>

      <div className="flex flex-col md:flex-row md:items-end gap-2 mb-3">
        <div className="flex flex-col gap-1 md:w-1/2">
          <label htmlFor={searchId} className="font-bold text-sm">
            Search
          </label>
          <input
            id={searchId}
            type="search"
            value={q}
            placeholder="Event or venue"
            onChange={(e) => update('q', e.target.value)}
            className="min-h-6 px-2 rounded-md border border-rule bg-surface text-base"
          />
        </div>
        <div role="group" aria-label="Date" className="flex flex-wrap gap-1">
          {(Object.keys(WHEN_LABELS) as When[]).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={when === w}
              onClick={() => update('when', w)}
              className="min-h-6 px-2 rounded-pill border border-rule bg-surface text-sm font-bold text-ink-soft hover:border-ink aria-pressed:bg-ink aria-pressed:text-surface aria-pressed:border-ink"
            >
              {WHEN_LABELS[w]}
            </button>
          ))}
        </div>
      </div>

      {events.isPending ? (
        <LoadingState label="Loading events" />
      ) : events.isError ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : events.data.events.length === 0 ? (
        <EmptyState title="Nothing on sale right now">New events appear here as soon as organizers publish them.</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No events match"
          action={
            <Button variant="secondary" onClick={() => setParams({}, { replace: true })}>
              Clear filters
            </Button>
          }
        >
          Try a different search or date range.
        </EmptyState>
      ) : (
        <>
          <p role="status" className="text-sm text-ink-soft mb-2">
            {filtered.length} {filtered.length === 1 ? 'event' : 'events'}
          </p>
          <ul className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((e) => (
              <li key={e.id} className="grid">
                <EventCard event={e} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
