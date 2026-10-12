import { useEffect, useState } from 'react';
import { serverNow } from '../lib/api';
import { formatCountdown } from '../lib/format';

/** Time left until `until` on the server's clock; ticks once a second. */
export function useTimeLeft(until: string | undefined): number {
  const target = until ? Date.parse(until) : 0;
  const [left, setLeft] = useState(() => target - serverNow());
  useEffect(() => {
    if (!target) return;
    setLeft(target - serverNow());
    const timer = setInterval(() => {
      setLeft(target - serverNow());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [target]);
  return Math.max(0, left);
}

/**
 * The hold timer. The visible digits update every second, but screen readers only hear
 * it at minute boundaries and in the final 30 seconds, not on every tick.
 */
export function Countdown({ msLeft, totalMs }: { msLeft: number; totalMs: number }) {
  const urgent = msLeft <= 60_000;
  const fraction = totalMs > 0 ? Math.min(1, msLeft / totalMs) : 0;
  const announce = msLeft <= 30_000 || Math.ceil(msLeft / 1000) % 60 === 0;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-ink-soft">Your seats are held for</p>
      <p className={`font-display font-extrabold text-3xl tabular-nums ${urgent ? 'text-accent-deep' : 'text-ink'}`}>
        {formatCountdown(msLeft)}
      </p>
      <div className="h-1 rounded-pill bg-rule overflow-hidden" aria-hidden>
        <div className={`h-full rounded-pill ${urgent ? 'bg-accent-deep' : 'bg-accent'}`} style={{ width: `${fraction * 100}%` }} />
      </div>
      <p className="sr-only" aria-live="polite">
        {announce ? `${formatCountdown(msLeft)} left to pay` : ''}
      </p>
    </div>
  );
}
