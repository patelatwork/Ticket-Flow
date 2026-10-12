import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { SeatMap } from '../components/SeatMap';
import { Button, ConflictNotice, EmptyState, ErrorState, LoadingState, errorMessage } from '../components/ui';
import { seatMapKey, useSeatStream, type StreamStatus } from '../hooks/useSeatStream';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatPaise } from '../lib/format';
import type { Booking, Seat, SeatMap as SeatMapData } from '../lib/types';

const MAX_SEATS = 10;

function LiveIndicator({ status }: { status: StreamStatus }) {
  const text = status === 'live' ? 'Live availability' : status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <p className="flex items-center gap-1 text-sm text-ink-soft" role="status">
      <span aria-hidden className={`size-1 rounded-pill ${status === 'live' ? 'bg-go' : 'bg-rule'}`} />
      {text}
    </p>
  );
}

export function EventDetailPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const seatMap = useQuery({
    queryKey: seatMapKey(id),
    queryFn: ({ signal }) => api<SeatMapData>(`/events/${id}/seats`, { signal }),
    // The SSE stream keeps this fresh; never refetch on a timer.
    staleTime: Infinity,
  });
  const streamStatus = useSeatStream(seatMap.isError ? undefined : id);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(new Set());
  const [lostWhileSelected, setLostWhileSelected] = useState<string[]>([]);
  // One idempotency key per hold attempt: a retry after a network error reuses it, so a
  // request that actually succeeded is replayed instead of holding seats twice.
  const attemptKey = useRef<string | null>(null);

  const seatsById = useMemo(() => new Map((seatMap.data?.seats ?? []).map((s) => [s.id, s])), [seatMap.data]);

  const hold = useMutation({
    mutationFn: (seatIds: string[]) => {
      attemptKey.current ??= crypto.randomUUID();
      return api<{ booking: Booking }>('/bookings', {
        method: 'POST',
        body: { eventId: id, seatIds },
        headers: { 'Idempotency-Key': attemptKey.current },
      });
    },
    onSuccess: ({ booking }) => {
      attemptKey.current = null;
      queryClient.setQueryData(['booking', booking.id], { booking });
      void navigate(`/checkout/${booking.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status !== 0) attemptKey.current = null;
      if (error instanceof ApiError && error.code === 'SEATS_UNAVAILABLE') {
        const taken = new Set(error.conflictingSeatIds);
        setConflicts(taken);
        setSelected((prev) => new Set([...prev].filter((sid) => !taken.has(sid))));
        // Reflect it immediately; the stream will confirm.
        queryClient.setQueryData<SeatMapData>(seatMapKey(id), (prev) =>
          prev ? { ...prev, seats: prev.seats.map((s) => (taken.has(s.id) && s.state === 'AVAILABLE' ? { ...s, state: 'HELD' } : s)) } : prev,
        );
      }
    },
  });

  // If someone else takes a seat we had picked (seen via the live stream), drop it and say so.
  // Paused while our own hold is in flight or done: the stream may report OUR new hold first.
  const holdActive = hold.isPending || hold.isSuccess;
  useEffect(() => {
    if (holdActive) return;
    const lost = [...selected].filter((sid) => {
      const state = seatsById.get(sid)?.state;
      return state !== undefined && state !== 'AVAILABLE';
    });
    if (lost.length === 0) return;
    setSelected((prev) => new Set([...prev].filter((sid) => !lost.includes(sid))));
    setLostWhileSelected(lost.map((sid) => seatsById.get(sid)?.label ?? '').filter(Boolean));
  }, [seatsById, selected, holdActive]);

  const toggle = (seat: Seat): void => {
    setConflicts(new Set());
    setLostWhileSelected([]);
    hold.reset();
    attemptKey.current = null;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seat.id)) next.delete(seat.id);
      else if (next.size < MAX_SEATS) next.add(seat.id);
      return next;
    });
  };

  if (seatMap.isPending) return <LoadingState label="Loading the seat map" />;
  if (seatMap.isError) return <ErrorState error={seatMap.error} onRetry={() => void seatMap.refetch()} />;

  const { event, seats } = seatMap.data;
  const picks = [...selected].map((sid) => seatsById.get(sid)).filter((s): s is Seat => s !== undefined);
  const total = picks.reduce((sum, s) => sum + s.pricePaise, 0);
  const conflictLabels = [...conflicts].map((sid) => seatsById.get(sid)?.label).filter(Boolean);
  const available = seats.filter((s) => s.state === 'AVAILABLE').length;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem] lg:items-start pb-12 lg:pb-0">
      <section aria-labelledby="event-title" className="flex flex-col gap-3 min-w-0">
        <header className="flex flex-col gap-1">
          <h1 id="event-title" className="text-2xl md:text-3xl font-extrabold">
            {event.title}
          </h1>
          <p className="text-ink-soft">
            {event.venue}, {formatDateTime(event.startsAt)}
          </p>
          {event.description && <p className="max-w-measure">{event.description}</p>}
          <LiveIndicator status={streamStatus} />
        </header>

        {event.status === 'CANCELLED' ? (
          <EmptyState title="This event was cancelled">Paid bookings are refunded automatically.</EmptyState>
        ) : seats.length === 0 ? (
          <EmptyState title="No seats yet">The organizer hasn’t added the seat layout.</EmptyState>
        ) : (
          <>
            {available === 0 && <p className="font-bold">Sold out. Seats on hold may come back if they aren’t paid for in time.</p>}
            <SeatMap seats={seats} selected={selected} conflicts={conflicts} onToggle={toggle} />
          </>
        )}
      </section>

      <aside
        aria-label="Your selection"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-rule bg-surface p-2 lg:sticky lg:top-2 lg:border lg:rounded-lg"
      >
        <div className="max-w-content mx-auto flex flex-col gap-2">
          {conflictLabels.length > 0 && (
            <ConflictNotice title={`${conflictLabels.join(', ')} ${conflictLabels.length === 1 ? 'was' : 'were'} just taken`}>
              Someone else got there first. Your other picks are kept; choose replacements and hold again.
            </ConflictNotice>
          )}
          {lostWhileSelected.length > 0 && (
            <ConflictNotice title={`${lostWhileSelected.join(', ')} just became unavailable`}>We removed it from your picks.</ConflictNotice>
          )}
          {hold.isError && !(hold.error instanceof ApiError && hold.error.code === 'SEATS_UNAVAILABLE') && (
            <p role="alert" className="text-sm text-accent-deep">
              {errorMessage(hold.error)}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <div aria-live="polite">
              <p className="font-bold">
                {picks.length === 0 ? 'No seats picked' : `${picks.length} ${picks.length === 1 ? 'seat' : 'seats'}: ${formatPaise(total)}`}
              </p>
              <p className="text-sm text-ink-soft hidden lg:block">
                {picks.length === 0 ? `Pick up to ${MAX_SEATS} seats on the map.` : picks.map((s) => s.label).join(', ')}
              </p>
            </div>
            {user ? (
              <Button disabled={picks.length === 0 || hold.isPending} onClick={() => hold.mutate(picks.map((s) => s.id))}>
                {hold.isPending ? 'Holding…' : 'Hold seats'}
              </Button>
            ) : (
              <Link to={`/login?next=${encodeURIComponent(`/events/${id}`)}`} className="px-3 py-1 rounded-pill bg-accent text-accent-ink font-bold">
                Sign in to hold
              </Link>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
