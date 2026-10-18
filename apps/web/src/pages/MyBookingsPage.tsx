import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { SubNav } from '../components/Layout';
import { BookingStatusBadge, Button, EmptyState, ErrorState, LoadingState, PageTitle, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, formatPaise } from '../lib/format';
import { ME_TABS } from '../lib/nav';
import type { Booking, Ticket } from '../lib/types';

type Show = 'all' | 'upcoming' | 'past';
const SHOW_LABELS: Record<Show, string> = { all: 'All', upcoming: 'Upcoming', past: 'Past' };

function DownloadButton({ ticket }: { ticket: Ticket }) {
  const download = useMutation({
    mutationFn: () => api<{ url: string }>(`/tickets/${ticket.id}/download`),
    onSuccess: ({ url }) => {
      // Short-lived presigned URL straight to storage.
      window.location.assign(url);
    },
  });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" disabled={!ticket.ready || download.isPending} onClick={() => download.mutate()}>
        {ticket.ready ? (download.isPending ? 'Preparing…' : 'Download PDF') : 'Generating…'}
      </Button>
      {download.isError && (
        <p role="alert" className="text-sm text-accent-deep">
          {errorMessage(download.error)}
        </p>
      )}
    </div>
  );
}

export function MyBookingsPage() {
  const bookings = useQuery({
    queryKey: ['my-bookings'],
    queryFn: ({ signal }) => api<{ bookings: Booking[] }>('/bookings', { signal }),
  });
  const tickets = useQuery({
    queryKey: ['my-tickets'],
    queryFn: ({ signal }) => api<{ tickets: Ticket[] }>('/tickets', { signal }),
    // Tickets render in the background after payment; poll until they're all ready.
    refetchInterval: (q) => {
      const paid = bookings.data?.bookings.filter((b) => b.status === 'PAID') ?? [];
      const list = q.state.data?.tickets ?? [];
      const expected = paid.reduce((n, b) => n + b.seats.length, 0);
      return list.length < expected || list.some((t) => !t.ready) ? 3000 : false;
    },
  });

  const [params, setParams] = useSearchParams();
  const showParam = params.get('show');
  const show: Show = showParam === 'upcoming' || showParam === 'past' ? showParam : 'all';

  const header = (
    <>
      <PageTitle>My tickets</PageTitle>
      <SubNav label="My tickets" items={ME_TABS} />
    </>
  );
  if (bookings.isPending)
    return (
      <>
        {header}
        <LoadingState label="Loading your bookings" />
      </>
    );
  if (bookings.isError)
    return (
      <>
        {header}
        <ErrorState error={bookings.error} onRetry={() => void bookings.refetch()} />
      </>
    );

  const now = Date.now();
  const list = bookings.data.bookings.filter((b) =>
    show === 'all' ? true : show === 'upcoming' ? Date.parse(b.eventStartsAt) > now : Date.parse(b.eventStartsAt) <= now,
  );
  const ticketsByBooking = new Map<string, Ticket[]>();
  for (const t of tickets.data?.tickets ?? []) {
    ticketsByBooking.set(t.bookingId, [...(ticketsByBooking.get(t.bookingId) ?? []), t]);
  }

  return (
    <>
      {header}
      {bookings.data.bookings.length > 0 && (
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1 mb-3">
          {(Object.keys(SHOW_LABELS) as Show[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={show === s}
              onClick={() => setParams(s === 'all' ? {} : { show: s }, { replace: true })}
              className="min-h-6 px-2 rounded-pill border border-rule bg-surface text-sm font-bold text-ink-soft hover:border-ink aria-pressed:bg-ink aria-pressed:text-surface aria-pressed:border-ink"
            >
              {SHOW_LABELS[s]}
            </button>
          ))}
        </div>
      )}
      {bookings.data.bookings.length === 0 ? (
        <EmptyState
          title="No bookings yet"
          action={
            <Link to="/events" className="font-bold underline underline-offset-4">
              Find an event
            </Link>
          }
        >
          Seats you hold or buy show up here.
        </EmptyState>
      ) : list.length === 0 ? (
        <EmptyState title={show === 'upcoming' ? 'Nothing coming up' : 'No past bookings'}>
          {show === 'upcoming' ? 'Bookings for future events show up here.' : 'Bookings for events that have happened show up here.'}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((b) => {
            const bookingTickets = ticketsByBooking.get(b.id) ?? [];
            return (
              <li key={b.id} className="bg-surface border border-rule rounded-lg p-2 md:p-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-bold">{b.eventTitle}</h2>
                    <p className="text-sm text-ink-soft">
                      {formatDateTime(b.eventStartsAt)}, {formatPaise(b.totalPaise)}
                    </p>
                  </div>
                  <BookingStatusBadge status={b.status} />
                </div>
                {b.status === 'HELD' && (
                  <Link to={`/checkout/${b.id}`} className="font-bold underline underline-offset-4 self-start">
                    Finish paying
                  </Link>
                )}
                {b.status === 'PAID' &&
                  (tickets.isError ? (
                    <ErrorState error={tickets.error} onRetry={() => void tickets.refetch()} />
                  ) : bookingTickets.length === 0 ? (
                    <LoadingState label="Preparing your tickets" />
                  ) : (
                    <ul className="flex flex-col">
                      {bookingTickets.map((t) => (
                        <li key={t.id} className="flex items-center justify-between gap-2 py-1 border-t border-rule first:border-t-0">
                          <span>
                            <span className="font-bold">Seat {t.seatLabel}</span> <span className="text-sm text-ink-soft">{t.tier}</span>
                            {t.usedAt && <span className="text-sm text-ink-soft"> (scanned {formatDateTime(t.usedAt)})</span>}
                          </span>
                          <DownloadButton ticket={t} />
                        </li>
                      ))}
                    </ul>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
