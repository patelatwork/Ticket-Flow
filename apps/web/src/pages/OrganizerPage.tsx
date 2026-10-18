import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { SubNav } from '../components/Layout';
import { CreateEventForm } from '../components/organizer/CreateEventForm';
import { SeatLayoutForm } from '../components/organizer/SeatLayoutForm';
import { Button, EmptyState, ErrorState, LoadingState, PageTitle, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { ORGANIZER_TABS } from '../lib/nav';
import type { EventSummary } from '../lib/types';

function DraftEvent({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient();
  const publish = useMutation({
    mutationFn: () => api(`/events/${event.id}/publish`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-events'] });
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
  return (
    <div className="flex flex-col gap-2">
      <SeatLayoutForm eventId={event.id} />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={publish.isPending} onClick={() => publish.mutate()}>
          {publish.isPending ? 'Publishing…' : 'Publish event'}
        </Button>
        <Link to={`/events/${event.id}`} className="font-bold underline underline-offset-4">
          Preview seat map
        </Link>
      </div>
      {publish.isError && (
        <p role="alert" className="text-accent-deep">
          {errorMessage(publish.error)}
        </p>
      )}
    </div>
  );
}

export function OrganizerPage() {
  const events = useQuery({
    queryKey: ['my-events'],
    queryFn: ({ signal }) => api<{ events: EventSummary[] }>('/events/mine', { signal }),
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageTitle sub="Create an event, lay out its seats, publish it, and watch sales come in.">Your events</PageTitle>
        <SubNav label="Organizer" items={ORGANIZER_TABS} />
      </div>

      <section aria-labelledby="events-heading" className="flex flex-col gap-2">
        <h2 id="events-heading" className="text-xl font-bold">
          All events
        </h2>
        {events.isPending ? (
          <LoadingState label="Loading your events" />
        ) : events.isError ? (
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
        ) : events.data.events.length === 0 ? (
          <EmptyState title="No events yet">Create your first one below.</EmptyState>
        ) : (
          <ul className="flex flex-col">
            {events.data.events.map((e) => (
              <li key={e.id} className="border-t border-rule py-2 flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-bold text-lg">{e.title}</p>
                    <p className="text-sm text-ink-soft">
                      {e.venue}, {formatDateTime(e.startsAt)}
                    </p>
                  </div>
                  <span className="text-sm font-bold">{e.status === 'DRAFT' ? 'Draft' : e.status === 'PUBLISHED' ? 'On sale' : 'Cancelled'}</span>
                </div>
                {e.status === 'DRAFT' && <DraftEvent event={e} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <CreateEventForm />
    </div>
  );
}
