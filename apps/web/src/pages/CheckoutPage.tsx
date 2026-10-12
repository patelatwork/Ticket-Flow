import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { Countdown, useTimeLeft } from '../components/Countdown';
import { BookingStatusBadge, Button, ConflictNotice, ErrorState, LoadingState, PageTitle, errorMessage } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatPaise } from '../lib/format';
import { openRazorpayCheckout } from '../lib/razorpay';
import type { Booking, Payment } from '../lib/types';

export function CheckoutPage() {
  const { bookingId = '' } = useParams();
  const queryClient = useQueryClient();

  const payment = useQuery({
    queryKey: ['payment', bookingId],
    queryFn: ({ signal }) => api<{ payment: Payment | null }>(`/bookings/${bookingId}/payment`, { signal }),
    // While the gateway is settling, poll until the webhook lands.
    refetchInterval: (q) => (q.state.data?.payment?.status === 'PENDING' ? 2000 : false),
  });
  const paymentPending = payment.data?.payment?.status === 'PENDING';

  const booking = useQuery({
    queryKey: ['booking', bookingId],
    queryFn: ({ signal }) => api<{ booking: Booking }>(`/bookings/${bookingId}`, { signal }),
    refetchInterval: paymentPending ? 2000 : false,
  });

  const msLeft = useTimeLeft(booking.data?.booking.holdExpiresAt);
  const status = booking.data?.booking.status;

  // When the hold runs out on screen, ask the server what actually happened.
  useEffect(() => {
    if (status === 'HELD' && msLeft === 0) {
      const t = setTimeout(() => void booking.refetch(), 1500);
      return () => {
        clearTimeout(t);
      };
    }
    return undefined;
  }, [status, msLeft, booking]);

  const refreshAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['booking', bookingId] });
    void queryClient.invalidateQueries({ queryKey: ['payment', bookingId] });
  };

  const pay = useMutation({
    mutationFn: () => api<{ payment: Payment }>(`/bookings/${bookingId}/pay`, { method: 'POST' }),
    onSuccess: async ({ payment: p }) => {
      queryClient.setQueryData(['payment', bookingId], { payment: p });
      if (p.provider === 'razorpay' && p.checkout) {
        await openRazorpayCheckout(p.checkout, { onClose: refreshAll });
      }
    },
    onError: refreshAll,
  });

  const cancel = useMutation({
    mutationFn: () => api<{ booking: Booking }>(`/bookings/${bookingId}/cancel`, { method: 'POST' }),
    onSuccess: (data) => {
      queryClient.setQueryData(['booking', bookingId], data);
    },
  });

  if (booking.isPending) return <LoadingState label="Loading your booking" />;
  if (booking.isError) return <ErrorState error={booking.error} onRetry={() => void booking.refetch()} />;

  const b = booking.data.booking;
  const totalMs = Date.parse(b.holdExpiresAt) - Date.parse(b.createdAt);
  const lastPayment = payment.data?.payment ?? null;

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_20rem] md:items-start">
      <section className="flex flex-col gap-3">
        <PageTitle sub={`${formatDateTime(b.eventStartsAt)}`}>{b.eventTitle}</PageTitle>
        <div className="flex items-center gap-2">
          <BookingStatusBadge status={b.status} />
        </div>

        {b.status === 'HELD' && !paymentPending && msLeft > 0 && <Countdown msLeft={msLeft} totalMs={totalMs} />}

        {b.status === 'HELD' && paymentPending && (
          <div role="status" className="p-2 rounded-md bg-go-wash flex flex-col gap-1">
            <p className="font-bold text-go">Confirming your payment</p>
            <p className="text-ink-soft">This usually takes a few seconds. You can leave this page; your tickets will appear under My tickets.</p>
          </div>
        )}

        {b.status === 'HELD' && lastPayment?.status === 'FAILED' && !paymentPending && (
          <ConflictNotice title="Your last payment didn’t go through">Your seats are still held. Try paying again.</ConflictNotice>
        )}

        {b.status === 'PAID' && (
          <div className="flex flex-col gap-2 items-start">
            <p className="text-lg font-bold">You’re in. Your tickets are being prepared.</p>
            <Link to="/me/bookings" className="px-3 py-1 rounded-pill bg-accent text-accent-ink font-bold">
              Go to my tickets
            </Link>
          </div>
        )}

        {b.status === 'EXPIRED' && (
          <ConflictNotice
            title="Your hold expired"
            action={
              <Link to={`/events/${b.eventId}`} className="font-bold underline underline-offset-4">
                Pick seats again
              </Link>
            }
          >
            {lastPayment && (lastPayment.status === 'PENDING' || lastPayment.status === 'REFUND_PENDING')
              ? 'If your payment went through, we’ll confirm these seats if they’re still free, or refund you automatically.'
              : 'The seats went back on sale.'}
          </ConflictNotice>
        )}
        {b.status === 'CANCELLED' && <p>You released these seats.</p>}
        {b.status === 'REFUNDED' && <p>This booking was refunded to your original payment method.</p>}
        {lastPayment?.status === 'REFUND_PENDING' || lastPayment?.status === 'REFUNDED' ? (
          <p className="text-sm text-ink-soft">
            Refund of {formatPaise(lastPayment.amountPaise)} {lastPayment.status === 'REFUNDED' ? 'issued' : 'in progress'}.
          </p>
        ) : null}

        {pay.isError && (
          <p role="alert" className="text-accent-deep">
            {pay.error instanceof ApiError && pay.error.code === 'HOLD_EXPIRED' ? 'Your hold expired before payment started.' : errorMessage(pay.error)}
          </p>
        )}
      </section>

      <aside aria-label="Order summary" className="border border-rule rounded-lg bg-surface p-2 flex flex-col gap-2">
        <h2 className="text-lg font-bold">Order</h2>
        <ul className="flex flex-col gap-1">
          {b.seats.map((s) => (
            <li key={s.id} className="flex justify-between gap-2">
              <span>
                Seat {s.label} <span className="text-ink-soft text-sm">{s.tier}</span>
              </span>
              <span className="tabular-nums">{formatPaise(s.pricePaise)}</span>
            </li>
          ))}
        </ul>
        <p className="flex justify-between border-t border-rule pt-1 font-bold">
          <span>Total</span>
          <span className="tabular-nums">{formatPaise(b.totalPaise)}</span>
        </p>
        {b.status === 'HELD' && (
          <>
            <Button disabled={pay.isPending || paymentPending || msLeft === 0} onClick={() => pay.mutate()}>
              {pay.isPending ? 'Starting payment…' : paymentPending ? 'Waiting for confirmation' : `Pay ${formatPaise(b.totalPaise)}`}
            </Button>
            <Button variant="quiet" disabled={cancel.isPending || paymentPending} onClick={() => cancel.mutate()}>
              Release seats
            </Button>
            {cancel.isError && (
              <p role="alert" className="text-sm text-accent-deep">
                {errorMessage(cancel.error)}
              </p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
