import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { BarList } from '../components/charts/BarList';
import { ChartCard, DataTable } from '../components/charts/ChartCard';
import { ColumnChart } from '../components/charts/ColumnChart';
import { MeterLegend, StackMeter } from '../components/charts/StackMeter';
import { StatTile } from '../components/charts/StatTile';
import { SubNav } from '../components/Layout';
import { EventDrilldown } from '../components/organizer/EventDrilldown';
import { EmptyState, ErrorState, LoadingState, PageTitle } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, formatDay, formatPaise, formatPaiseCompact, formatPercent, formatRelative } from '../lib/format';
import { ORGANIZER_TABS } from '../lib/nav';
import type { DailyReport, EventSales, SalesAnalytics } from '../lib/types';

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];
/** Label every nth day so axis labels never collide. */
const LABEL_EVERY: Record<Range, number> = { 7: 2, 30: 7, 90: 30 };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function RevenueCard({ analytics }: { analytics: SalesAnalytics }) {
  // Read the range off the data, not the URL: while a new range loads, the old data stays up.
  const range = analytics.days as Range;
  const columns = analytics.timeline.map((d) => ({
    key: d.date,
    label: formatDay(d.date),
    detail: formatDay(d.date, true),
    value: d.grossPaise,
    extra: plural(d.ticketsSold, 'ticket'),
  }));
  return (
    <ChartCard
      title="Revenue per day"
      sub={`Settled payments, last ${range} days (UTC)`}
      table={
        <DataTable
          columns={['Day', 'Revenue', 'Orders', 'Tickets']}
          rows={[...analytics.timeline].reverse().map((d) => [formatDay(d.date, true), formatPaise(d.grossPaise), d.bookingsPaid, d.ticketsSold])}
        />
      }
    >
      <ColumnChart
        data={columns}
        format={formatPaise}
        tickFormat={formatPaiseCompact}
        minStep={100_000}
        label={`Revenue per day, last ${range} days`}
        labelEvery={LABEL_EVERY[range] ?? 1}
      />
    </ChartCard>
  );
}

function SellThroughCard({ events }: { events: EventSales[] }) {
  return (
    <ChartCard
      title="Sell-through by event"
      sub="Seats sold and on hold right now"
      table={
        <DataTable
          columns={['Event', 'Sold', 'On hold', 'Capacity', 'Gross', 'Refunded']}
          rows={events.map((e) => [e.title, e.seatsSold, e.seatsHeld, e.totalSeats, formatPaise(e.grossPaise), formatPaise(e.refundedPaise)])}
        />
      }
    >
      <MeterLegend />
      <ul className="flex flex-col gap-2">
        {events.map((e) => (
          <li key={e.eventId} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="min-w-0">
                <span className="font-bold">{e.title}</span>
                <span className="text-sm text-ink-soft">
                  {' '}
                  · {formatDateTime(e.startsAt)}
                  {e.status !== 'PUBLISHED' && ` · ${e.status.toLowerCase()}`}
                </span>
              </span>
              <span className="text-sm tabular-nums">
                <span className="font-bold">{formatPercent(e.totalSeats ? e.seatsSold / e.totalSeats : 0)}</span>
                <span className="text-ink-soft">
                  {' '}
                  · {e.seatsSold}/{e.totalSeats}
                </span>
              </span>
            </div>
            <StackMeter label={e.title} sold={e.seatsSold} held={e.seatsHeld} total={e.totalSeats} />
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

function TierCard({ tiers }: { tiers: SalesAnalytics['tiers'] }) {
  return (
    <ChartCard
      title="Revenue by tier"
      sub="All events, all time"
      table={
        <DataTable
          columns={['Tier', 'Revenue', 'Sold', 'On hold', 'Capacity']}
          rows={tiers.map((t) => [t.tier, formatPaise(t.grossPaise), t.seatsSold, t.seatsHeld, t.totalSeats])}
        />
      }
    >
      {tiers.length === 0 ? (
        <p className="text-ink-soft">No seats laid out yet.</p>
      ) : (
        <BarList
          label="Revenue by tier"
          rows={tiers.map((t) => ({
            key: t.tier,
            label: t.tier,
            sub: `${t.seatsSold}/${t.totalSeats} sold`,
            value: t.grossPaise,
            display: formatPaise(t.grossPaise),
          }))}
        />
      )}
    </ChartCard>
  );
}

function RecentSalesCard({ recent }: { recent: SalesAnalytics['recent'] }) {
  return (
    <ChartCard title="Latest sales" sub="Most recent settled payments">
      {recent.length === 0 ? (
        <p className="text-ink-soft">No sales yet. They appear here the moment a payment settles.</p>
      ) : (
        <ol className="flex flex-col">
          {recent.slice(0, 5).map((r) => (
            <li key={r.bookingId} className="border-t border-rule first:border-t-0 py-1 flex items-baseline justify-between gap-2">
              <span className="min-w-0">
                <span className="font-bold block truncate">{r.eventTitle}</span>
                <span className="text-sm text-ink-soft">
                  {plural(r.seats, 'seat')} · {formatRelative(r.paidAt)}
                </span>
              </span>
              <span className="font-bold tabular-nums whitespace-nowrap">{formatPaise(r.amountPaise)}</span>
            </li>
          ))}
        </ol>
      )}
    </ChartCard>
  );
}

export function OrganizerDashboardPage() {
  const [params, setParams] = useSearchParams();
  const rangeParam = Number(params.get('range'));
  const range: Range = rangeParam === 7 || rangeParam === 90 ? rangeParam : 30;

  const sales = useQuery({
    queryKey: ['sales'],
    queryFn: ({ signal }) => api<{ events: EventSales[]; daily: DailyReport[] }>('/organizer/sales', { signal }),
    refetchInterval: 15_000,
  });
  const analytics = useQuery({
    queryKey: ['analytics', range],
    queryFn: ({ signal }) => api<SalesAnalytics>(`/organizer/analytics?days=${range}`, { signal }),
    refetchInterval: 15_000,
    // Switching range keeps the old chart on screen (dimmed) instead of flashing a spinner.
    placeholderData: keepPreviousData,
  });

  const header = (
    <>
      <PageTitle sub="Live sales across your events. Refreshes every 15 seconds.">Organizer dashboard</PageTitle>
      <SubNav label="Organizer" items={ORGANIZER_TABS} />
    </>
  );

  if (sales.isPending || analytics.isPending)
    return (
      <>
        {header}
        <LoadingState label="Loading your sales" />
      </>
    );
  if (sales.isError || analytics.isError) {
    const failed = sales.isError ? sales : analytics;
    return (
      <>
        {header}
        <ErrorState error={failed.error} onRetry={() => void failed.refetch()} />
      </>
    );
  }

  const events = sales.data.events;
  if (events.length === 0)
    return (
      <>
        {header}
        <EmptyState
          title="No events yet"
          action={
            <Link to="/organizer/events" className="font-bold underline underline-offset-4">
              Create your first event
            </Link>
          }
        >
          Your revenue, sell-through and live holds show up here once you publish an event.
        </EmptyState>
      </>
    );

  const gross = events.reduce((n, e) => n + e.grossPaise, 0);
  const refunded = events.reduce((n, e) => n + e.refundedPaise, 0);
  const sold = events.reduce((n, e) => n + e.seatsSold, 0);
  const held = events.reduce((n, e) => n + e.seatsHeld, 0);
  const capacity = events.filter((e) => e.status === 'PUBLISHED').reduce((n, e) => n + e.totalSeats, 0);
  const orders = events.reduce((n, e) => n + e.bookingsPaid, 0);
  const a = analytics.data;
  const periodGross = a.timeline.reduce((n, d) => n + d.grossPaise, 0);
  const periodTickets = a.timeline.reduce((n, d) => n + d.ticketsSold, 0);

  return (
    <>
      {header}
      <div className="flex flex-col gap-3">
        {/* One filter row, above everything it scopes. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="Period" className="flex flex-wrap items-center gap-1">
            <span className="text-sm font-bold text-ink-soft mr-1">Period</span>
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                onClick={() => setParams(r === 30 ? {} : { range: String(r) }, { replace: true })}
                className="min-h-6 px-2 rounded-pill border border-rule bg-surface text-sm font-bold text-ink-soft hover:border-ink aria-pressed:bg-ink aria-pressed:text-surface aria-pressed:border-ink"
              >
                {r} days
              </button>
            ))}
          </div>
          <Link to="/organizer/events" className="font-bold underline underline-offset-4">
            Create an event
          </Link>
        </div>

        <dl className="grid grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] gap-2">
          <div className="col-span-2 lg:col-span-1 grid">
            <StatTile hero label="Net revenue" value={formatPaise(gross - refunded)} hint={refunded > 0 ? `${formatPaise(gross)} gross − ${formatPaise(refunded)} refunded` : `${plural(orders, 'paid order')}, all time`} />
          </div>
          <StatTile label={`Last ${a.days} days`} value={formatPaise(periodGross)} hint={plural(periodTickets, 'ticket')} />
          <StatTile label="Sell-through" value={formatPercent(capacity ? sold / capacity : 0)} hint={`${sold} of ${capacity} on-sale seats`} />
          <div className="col-span-2 lg:col-span-1 grid">
            <StatTile label="Live holds" value={held} hint={held > 0 ? 'Seats in someone’s checkout now' : 'No one checking out'} />
          </div>
        </dl>

        <div className={`grid gap-2 lg:grid-cols-[2fr_1fr] transition-opacity ${analytics.isPlaceholderData ? 'opacity-50' : ''}`}>
          <RevenueCard analytics={a} />
          <TierCard tiers={a.tiers} />
        </div>

        <div className="grid gap-2 lg:grid-cols-[2fr_1fr]">
          <SellThroughCard events={events} />
          <RecentSalesCard recent={a.recent} />
        </div>

        <EventDrilldown events={events} />
      </div>
    </>
  );
}
