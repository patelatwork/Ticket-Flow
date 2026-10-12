import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { BookingStatusBadge, Button, EmptyState, ErrorState, LoadingState, PageTitle, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, formatPaise } from '../lib/format';
import type { Booking, Ticket } from '../lib/types';

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

  if (bookings.isPending) return <LoadingState label="Loading your bookings" />;
  if (bookings.isError) return <ErrorState error={bookings.error} onRetry={() => void bookings.refetch()} />;

  const list = bookings.data.bookings;
  const ticketsByBooking = new Map<string, Ticket[]>();
  for (const t of tickets.data?.tickets ?? []) {
    ticketsByBooking.set(t.bookingId, [...(ticketsByBooking.get(t.bookingId) ?? []), t]);
  }

  return (
    <>
      <PageTitle>My tickets</PageTitle>
      {list.length === 0 ? (
        <EmptyState
          title="No bookings yet"
          action={
            <Link to="/" className="font-bold underline underline-offset-4">
              Find an event
            </Link>
          }
        >
          Seats you hold or buy show up here.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((b) => {
            const bookingTickets = ticketsByBooking.get(b.id) ?? [];
            return (
              <li key={b.id} className="border-t border-rule pt-2 flex flex-col gap-2">
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
