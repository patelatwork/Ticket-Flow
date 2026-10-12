import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatPaise } from '../../lib/format';
import type { DailyReport, EventSales } from '../../lib/types';
import { EmptyState, ErrorState, LoadingState } from '../ui';

const th = 'text-left font-bold text-sm text-ink-soft py-1 pr-2 border-b border-rule whitespace-nowrap';
const td = 'py-1 pr-2 border-b border-rule tabular-nums whitespace-nowrap';

export function SalesTable() {
  const sales = useQuery({
    queryKey: ['sales'],
    queryFn: ({ signal }) => api<{ events: EventSales[]; daily: DailyReport[] }>('/organizer/sales', { signal }),
    refetchInterval: 15_000,
  });

  if (sales.isPending) return <LoadingState label="Loading sales" />;
  if (sales.isError) return <ErrorState error={sales.error} onRetry={() => void sales.refetch()} />;
  if (sales.data.events.length === 0) return <EmptyState title="No sales yet">Sales appear here once an event is published.</EmptyState>;

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="text-left text-xl font-bold font-display pb-1">Sales by event</caption>
          <thead>
            <tr>
              <th scope="col" className={th}>Event</th>
              <th scope="col" className={th}>Sold</th>
              <th scope="col" className={th}>On hold</th>
              <th scope="col" className={th}>Gross</th>
              <th scope="col" className={th}>Refunded</th>
            </tr>
          </thead>
          <tbody>
            {sales.data.events.map((e) => (
              <tr key={e.eventId}>
                <th scope="row" className={`${td} font-normal text-left`}>
                  <span className="font-bold">{e.title}</span>
                  <span className="block text-sm text-ink-soft">
                    {formatDateTime(e.startsAt)}
                    {e.status !== 'PUBLISHED' && `, ${e.status.toLowerCase()}`}
                  </span>
                </th>
                <td className={td}>
                  {e.seatsSold} / {e.totalSeats}
                </td>
                <td className={td}>{e.seatsHeld}</td>
                <td className={td}>{formatPaise(e.grossPaise)}</td>
                <td className={td}>{formatPaise(e.refundedPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sales.data.daily.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <caption className="text-left text-xl font-bold font-display pb-1">Daily reports</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>Day (UTC)</th>
                <th scope="col" className={th}>Bookings</th>
                <th scope="col" className={th}>Tickets</th>
                <th scope="col" className={th}>Gross</th>
                <th scope="col" className={th}>Refunded</th>
              </tr>
            </thead>
            <tbody>
              {sales.data.daily.map((d) => (
                <tr key={d.reportDate}>
                  <th scope="row" className={`${td} font-normal text-left`}>{d.reportDate}</th>
                  <td className={td}>{d.bookingsPaid}</td>
                  <td className={td}>{d.ticketsSold}</td>
                  <td className={td}>{formatPaise(d.grossPaise)}</td>
                  <td className={td}>{formatPaise(d.refundedPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
