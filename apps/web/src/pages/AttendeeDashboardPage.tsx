import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { BarList } from '../components/charts/BarList';
import { ChartCard, DataTable } from '../components/charts/ChartCard';
import { ColumnChart } from '../components/charts/ColumnChart';
import { StatTile } from '../components/charts/StatTile';
import { useTimeLeft } from '../components/Countdown';
import { SubNav } from '../components/Layout';
import { BookingStatusBadge, ConflictNotice, EmptyState, ErrorState, LoadingState, PageTitle } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dayAndMonth, formatCountdown, formatDateTime, formatMonthYear, formatPaise, formatPaiseCompact, formatRelative } from '../lib/format';
import { ME_TABS } from '../lib/nav';
import type { Booking, BookingStatus } from '../lib/types';

const MONTHS = 6;

/** Paid spend per calendar month for the last MONTHS months, oldest first, zero-filled. */
function spendByMonth(paid: Booking[], now: Date) {
  const months = Array.from({ length: MONTHS }, (_, i) => new Date(now.getFullYear(), now.getMonth() - (MONTHS - 1 - i), 1));
  return months.map((start) => {
    const inMonth = paid.filter((b) => {
      const d = new Date(b.createdAt);
      return d.getFullYear() === start.getFullYear() && d.getMonth() === start.getMonth();
    });
    const tickets = inMonth.reduce((n, b) => n + b.seats.length, 0);
    return {
      key: start.toISOString(),
      label: formatMonthYear(start).split(' ')[0] ?? '',
      detail: formatMonthYear(start),
      value: inMonth.reduce((n, b) => n + b.totalPaise, 0),
      extra: `${tickets} ${tickets === 1 ? 'ticket' : 'tickets'}`,
    };
  });
}

function seatsByTier(paid: Booking[]) {
  const tiers = new Map<string, { seats: number; paise: number }>();
  for (const b of paid) {
    for (const s of b.seats) {
      const t = tiers.get(s.tier) ?? { seats: 0, paise: 0 };
      tiers.set(s.tier, { seats: t.seats + 1, paise: t.paise + s.pricePaise });
    }
  }
  return [...tiers.entries()].sort(([, a], [, b]) => b.seats - a.seats);
}

interface UpcomingEvent {
  eventId: string;
  title: string;
  startsAt: string;
  seats: string[];
}

/** Paid bookings for future events, one entry per event (several orders merge), soonest first. */
function upcomingEvents(paid: Booking[], now: number): UpcomingEvent[] {
  const byEvent = new Map<string, UpcomingEvent>();
  for (const b of paid) {
    if (Date.parse(b.eventStartsAt) <= now) continue;
    const e = byEvent.get(b.eventId) ?? { eventId: b.eventId, title: b.eventTitle, startsAt: b.eventStartsAt, seats: [] };
    e.seats.push(...b.seats.map((s) => s.label));
    byEvent.set(b.eventId, e);
  }
  return [...byEvent.values()]
    .map((e) => ({ ...e, seats: e.seats.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) }))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

const SEATS_SHOWN = 6;

/** "Seat G1" / "8 seats: A1, A2, … +2 more". The Tickets tab lists every seat. */
function seatsText(seats: string[]): string {
  if (seats.length === 1) return `Seat ${seats[0] ?? ''}`;
  const more = seats.length - SEATS_SHOWN;
  return `${seats.length} seats: ${seats.slice(0, SEATS_SHOWN).join(', ')}${more > 0 ? ` +${more} more` : ''}`;
}

function HeldNotice({ booking }: { booking: Booking }) {
  const left = useTimeLeft(booking.holdExpiresAt);
  if (left <= 0) return null;
  return (
    <ConflictNotice
      title={`Seats held for ${booking.eventTitle}`}
      action={
        <Link to={`/checkout/${booking.id}`} className="self-start font-bold underline underline-offset-4 text-accent-deep">
          Finish paying
        </Link>
      }
    >
      {booking.seats.map((s) => s.label).join(', ')} · {formatPaise(booking.totalPaise)} · released in {formatCountdown(left)} if you don’t pay.
    </ConflictNotice>
  );
}

function NextUp({ event }: { event: UpcomingEvent }) {
  const { day, month } = dayAndMonth(event.startsAt);
  return (
    <section aria-labelledby="next-up" className="stub bg-ink text-surface rounded-lg grid grid-cols-[auto_1fr]">
      <span aria-hidden className="flex flex-col items-center justify-center px-3 py-2 border-r border-dashed border-ink-soft leading-none">
        <span className="font-display font-extrabold text-3xl">{day}</span>
        <span className="text-sm uppercase opacity-80">{month}</span>
      </span>
      <div className="p-2 md:p-3 flex flex-col gap-1 min-w-0">
        <p className="text-sm font-bold uppercase tracking-wide text-accent-wash">Next up · {formatRelative(event.startsAt)}</p>
        <h2 id="next-up" className="text-xl md:text-2xl font-extrabold">
          {event.title}
        </h2>
        <p className="opacity-80">
          {formatDateTime(event.startsAt)} · {seatsText(event.seats)}
        </p>
        <Link to="/me/bookings" className="self-start mt-1 font-bold underline underline-offset-4">
          View tickets
        </Link>
      </div>
    </section>
  );
}

const OUTCOMES: BookingStatus[] = ['PAID', 'HELD', 'EXPIRED', 'CANCELLED', 'REFUNDED'];

export function AttendeeDashboardPage() {
  const { user } = useAuth();
  const bookings = useQuery({
    queryKey: ['my-bookings'],
    queryFn: ({ signal }) => api<{ bookings: Booking[] }>('/bookings', { signal }),
  });

  const title = <PageTitle sub={user?.email}>Your tickets at a glance</PageTitle>;
  if (bookings.isPending)
    return (
      <>
        {title}
        <SubNav label="My tickets" items={ME_TABS} />
        <LoadingState label="Loading your bookings" />
      </>
    );
  if (bookings.isError)
    return (
      <>
        {title}
        <SubNav label="My tickets" items={ME_TABS} />
        <ErrorState error={bookings.error} onRetry={() => void bookings.refetch()} />
      </>
    );

  const list = bookings.data.bookings;
  const now = Date.now();
  const paid = list.filter((b) => b.status === 'PAID');
  const upcoming = upcomingEvents(paid, now);
  const held = list.filter((b) => b.status === 'HELD' && Date.parse(b.holdExpiresAt) > now);
  const spent = paid.reduce((n, b) => n + b.totalPaise, 0);
  const tickets = paid.reduce((n, b) => n + b.seats.length, 0);
  const attended = new Set(paid.filter((b) => Date.parse(b.eventStartsAt) <= now).map((b) => b.eventId)).size;
  const months = spendByMonth(paid, new Date(now));
  const tiers = seatsByTier(paid);
  const outcomes = OUTCOMES.map((s) => ({ status: s, n: list.filter((b) => b.status === s).length })).filter((o) => o.n > 0);

  return (
    <>
      {title}
      <SubNav label="My tickets" items={ME_TABS} />
      {list.length === 0 ? (
        <EmptyState
          title="No bookings yet"
          action={
            <Link to="/events" className="font-bold underline underline-offset-4">
              Find an event
            </Link>
          }
        >
          Once you book, your spending, upcoming events and tickets show up here.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {held.map((b) => (
            <HeldNotice key={b.id} booking={b} />
          ))}

          {upcoming[0] ? (
            <NextUp event={upcoming[0]} />
          ) : (
            <div className="bg-surface border border-rule rounded-lg p-2 md:p-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-ink-soft">Nothing coming up. Find your next night out.</p>
              <Link to="/events" className="font-bold underline underline-offset-4">
                Browse events
              </Link>
            </div>
          )}

          <dl className="grid grid-cols-3 lg:grid-cols-4 gap-1 md:gap-2">
            <div className="col-span-3 lg:col-span-1 grid">
              <StatTile hero label="Total spent" value={formatPaise(spent)} hint={`${paid.length} paid ${paid.length === 1 ? 'order' : 'orders'}`} />
            </div>
            <StatTile label="Tickets" value={tickets} hint="Seats you’ve paid for" />
            <StatTile label="Upcoming events" value={upcoming.length} hint={upcoming[0] ? `Next ${formatRelative(upcoming[0].startsAt)}` : 'None booked'} />
            <StatTile label="Events attended" value={attended} hint="Past events with tickets" />
          </dl>

          <div className="grid gap-2 lg:grid-cols-[2fr_1fr]">
            <ChartCard
              title="Spending by month"
              sub={`Paid orders, last ${MONTHS} months`}
              table={<DataTable columns={['Month', 'Spent', 'Tickets']} rows={months.map((m) => [m.detail, formatPaise(m.value), m.extra])} />}
            >
              <ColumnChart data={months} format={formatPaise} tickFormat={formatPaiseCompact} minStep={100_000} label="Spending by month" />
            </ChartCard>

            <ChartCard title="Seats by tier" sub="Across all paid orders">
              {tiers.length === 0 ? (
                <p className="text-ink-soft">No paid seats yet.</p>
              ) : (
                <BarList
                  label="Seats by tier"
                  rows={tiers.map(([tier, t]) => ({
                    key: tier,
                    label: tier,
                    sub: formatPaise(t.paise),
                    value: t.seats,
                    display: `${t.seats} ${t.seats === 1 ? 'seat' : 'seats'}`,
                  }))}
                />
              )}
            </ChartCard>
          </div>

          <div className="grid gap-2 lg:grid-cols-[2fr_1fr]">
            <ChartCard title="Coming up" sub="Your paid events, soonest first">
              {upcoming.length === 0 ? (
                <p className="text-ink-soft">No upcoming events.</p>
              ) : (
                <ol className="flex flex-col">
                  {upcoming.map((e) => (
                    <li key={e.eventId} className="border-t border-rule first:border-t-0 py-1 flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="min-w-0">
                        <Link to={`/events/${e.eventId}`} className="font-bold hover:text-accent">
                          {e.title}
                        </Link>
                        <span className="block text-sm text-ink-soft">
                          {formatDateTime(e.startsAt)} · {seatsText(e.seats)}
                        </span>
                      </span>
                      <span className="text-sm font-bold">{formatRelative(e.startsAt)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </ChartCard>

            <ChartCard title="Booking history" sub={`${list.length} ${list.length === 1 ? 'booking' : 'bookings'} in total`}>
              <ul className="flex flex-col gap-1">
                {outcomes.map((o) => (
                  <li key={o.status} className="flex items-center justify-between gap-2">
                    <BookingStatusBadge status={o.status} />
                    <span className="font-bold tabular-nums">{o.n}</span>
                  </li>
                ))}
              </ul>
            </ChartCard>
          </div>
        </div>
      )}
    </>
  );
}
