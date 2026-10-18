import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { seatMapKey, useSeatStream } from '../../hooks/useSeatStream';
import { api } from '../../lib/api';
import { formatPaise, formatPaiseCompact, formatPercent, splitLabel } from '../../lib/format';
import type { EventSales, Seat, SeatMap } from '../../lib/types';
import { BarList } from '../charts/BarList';
import { ChartCard } from '../charts/ChartCard';
import { StatTile } from '../charts/StatTile';
import { ErrorState, LoadingState, SelectField } from '../ui';

function byRow(seats: Seat[]): [string, Seat[]][] {
  const rows = new Map<string, Seat[]>();
  for (const s of seats) {
    const { row } = splitLabel(s.label);
    rows.set(row, [...(rows.get(row) ?? []), s]);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([row, list]) => [row, list.sort((a, b) => splitLabel(a.label).num - splitLabel(b.label).num)]);
}

/** A read-only, miniature seat map: same shapes and patterns as the buyer's map. */
function OccupancyMap({ seats }: { seats: Seat[] }) {
  const sold = seats.filter((s) => s.state === 'SOLD').length;
  const held = seats.filter((s) => s.state === 'HELD').length;
  return (
    <div
      role="img"
      aria-label={`Seat map: ${sold} sold, ${held} on hold, ${seats.length - sold - held} available`}
      className="flex flex-col items-center gap-(--seat-gap) overflow-x-auto [--seat:calc(var(--space)*1.75)] [--seat-gap:calc(var(--space)/4)]"
    >
      <span aria-hidden className="stage w-3/4 bg-ink text-surface text-xs font-bold tracking-widest text-center mb-1">
        STAGE
      </span>
      {byRow(seats).map(([row, list]) => (
        <div key={row} aria-hidden className="flex items-center gap-(--seat-gap)">
          <span className="w-2 text-xs font-bold text-muted text-right">{row}</span>
          {list.map((s) => (
            <span key={s.id} data-state={s.state} title={`${s.label} · ${s.tier} · ${s.state.toLowerCase()}`} className="seat cursor-default!" />
          ))}
        </div>
      ))}
      <ul aria-hidden className="flex flex-wrap justify-center gap-x-2 gap-y-1 pt-1 text-xs text-ink-soft">
        <li className="flex items-center gap-1">
          <span data-state="AVAILABLE" className="seat" /> Available
        </li>
        <li className="flex items-center gap-1">
          <span data-state="HELD" className="seat" /> On hold
        </li>
        <li className="flex items-center gap-1">
          <span data-state="SOLD" className="seat" /> Sold
        </li>
      </ul>
    </div>
  );
}

function EventDetail({ event }: { event: EventSales }) {
  const seatMap = useQuery({
    queryKey: seatMapKey(event.eventId),
    queryFn: ({ signal }) => api<SeatMap>(`/events/${event.eventId}/seats`, { signal }),
    // The live stream below keeps this fresh.
    staleTime: Infinity,
  });
  const stream = useSeatStream(seatMap.isError ? undefined : event.eventId);

  if (seatMap.isPending) return <LoadingState label="Loading seat map" />;
  if (seatMap.isError) return <ErrorState error={seatMap.error} onRetry={() => void seatMap.refetch()} />;

  const seats = seatMap.data.seats;
  if (seats.length === 0)
    return (
      <p className="text-ink-soft">
        No seats laid out yet.{' '}
        <Link to="/organizer/events" className="font-bold underline underline-offset-4">
          Add seats
        </Link>
      </p>
    );

  const tiers = new Map<string, { total: number; sold: number; paise: number; price: number }>();
  for (const s of seats) {
    const t = tiers.get(s.tier) ?? { total: 0, sold: 0, paise: 0, price: s.pricePaise };
    tiers.set(s.tier, { ...t, total: t.total + 1, sold: t.sold + (s.state === 'SOLD' ? 1 : 0), paise: t.paise + (s.state === 'SOLD' ? s.pricePaise : 0) });
  }
  const potential = seats.reduce((n, s) => n + s.pricePaise, 0);
  const sold = seats.filter((s) => s.state === 'SOLD').length;

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1 text-sm text-ink-soft" role="status">
        <span aria-hidden className={`size-1 rounded-pill ${stream === 'live' ? 'bg-go' : 'bg-rule'}`} />
        {stream === 'live' ? 'Live' : stream === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
      </p>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatTile label="Sell-through" value={formatPercent(seats.length ? sold / seats.length : 0)} hint={`${sold} of ${seats.length} seats`} />
        <StatTile label="Gross" value={formatPaise(event.grossPaise)} hint={event.refundedPaise > 0 ? `${formatPaise(event.refundedPaise)} refunded` : 'No refunds'} />
        <StatTile label="Sold-out value" value={formatPaiseCompact(potential)} hint={`${formatPaise(potential)} if every seat sells`} />
        <StatTile label="Avg order" value={event.bookingsPaid ? formatPaise(Math.round(event.grossPaise / event.bookingsPaid)) : '—'} hint={`${event.bookingsPaid} paid ${event.bookingsPaid === 1 ? 'order' : 'orders'}`} />
      </dl>
      <div className="grid gap-3 lg:grid-cols-[3fr_2fr] lg:items-start pt-1">
        <OccupancyMap seats={seats} />
        <div className="flex flex-col gap-1">
          <h3 className="font-bold">Sold by tier</h3>
          <BarList
            label="Seats sold by tier"
            max={1}
            rows={[...tiers.entries()]
              .sort(([, a], [, b]) => b.price - a.price)
              .map(([tier, t]) => ({
                key: tier,
                label: tier,
                sub: `${formatPaise(t.price)} · ${formatPaise(t.paise)} so far`,
                value: t.total ? t.sold / t.total : 0,
                display: `${t.sold}/${t.total}`,
              }))}
          />
        </div>
      </div>
    </div>
  );
}

export function EventDrilldown({ events }: { events: EventSales[] }) {
  const [selectedId, setSelectedId] = useState(events[0]?.eventId ?? '');
  const selected = events.find((e) => e.eventId === selectedId) ?? events[0];
  if (!selected) return null;
  return (
    <ChartCard title="Event close-up" sub="Live occupancy and tier performance for one event">
      <div className="md:w-1/2">
        <SelectField label="Event" value={selected.eventId} onChange={(e) => setSelectedId(e.target.value)}>
          {events.map((e) => (
            <option key={e.eventId} value={e.eventId}>
              {e.title}
              {e.status !== 'PUBLISHED' ? ` (${e.status.toLowerCase()})` : ''}
            </option>
          ))}
        </SelectField>
      </div>
      <EventDetail key={selected.eventId} event={selected} />
    </ChartCard>
  );
}
