import { useState, type KeyboardEvent } from 'react';
import { niceCeil } from '../../lib/format';

export interface Column {
  key: string;
  /** Short x-axis label, e.g. "18 Oct". */
  label: string;
  /** Tooltip heading, e.g. "Sun, 18 Oct". */
  detail: string;
  value: number;
  /** Secondary tooltip line, e.g. "3 tickets". */
  extra?: string;
}

const TICKS = 3;

/**
 * Single-series column chart (one color, so no legend: the card title names the series).
 * Hover or arrow-key through the columns for a tooltip; the peak is labelled directly.
 * One tab stop for the whole plot (roving tabindex), not one per column.
 */
export function ColumnChart({
  data,
  format,
  tickFormat = format,
  label,
  labelEvery = 1,
  minStep = 1,
}: {
  data: Column[];
  format: (n: number) => string;
  tickFormat?: (n: number) => string;
  label: string;
  labelEvery?: number;
  /** Smallest gap between ticks, so an all-zero series still gets a sensible axis. */
  minStep?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(Math.max(0, data.length - 1));
  // A nice step (not a nice max) keeps every tick a round number: 0 / 25K / 50K / 75K.
  const step = Math.max(minStep, niceCeil(Math.max(0, ...data.map((d) => d.value)) / TICKS));
  const max = step * TICKS;
  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? 0) ? i : best), 0);
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => step * i);
  // Edge columns anchor their labels inward so nothing spills out of the plot.
  const edge = (i: number) => (i < data.length * 0.2 ? 'left' : i >= data.length * 0.8 ? 'right' : 'center');

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? data.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const clamped = Math.min(data.length - 1, Math.max(0, next));
    setFocusIndex(clamped);
    setActive(clamped);
    e.currentTarget.parentElement?.querySelectorAll('button')[clamped]?.focus();
  }

  const shown = active === null ? undefined : data[active];
  const align = active === null ? 'center' : edge(active);
  const anchor = align === 'left' ? 0 : align === 'right' ? 1 : 0.5;

  return (
    <figure className="m-0 grid grid-cols-[auto_1fr] gap-x-1">
      {/* y-axis */}
      <div className="chart-plot relative text-xs text-muted tabular-nums" aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: `${(t / max) * 100}%` }}>
            {tickFormat(t)}
          </span>
        ))}
        {/* the widest label, invisible, reserves the column's width */}
        <span className="invisible block leading-none">{tickFormat(max)}</span>
      </div>

      <div className="chart-plot relative" onMouseLeave={() => setActive(null)}>
        {ticks.map((t) => (
          <span key={t} aria-hidden className="absolute inset-x-0 border-t border-rule" style={{ bottom: `${(t / max) * 100}%` }} />
        ))}
        <div role="group" aria-label={label} className="absolute inset-0 flex items-end gap-(--mark-gap)">
          {data.map((d, i) => {
            const pct = (d.value / max) * 100;
            return (
              <button
                key={d.key}
                type="button"
                tabIndex={i === focusIndex ? 0 : -1}
                aria-label={`${d.detail}: ${format(d.value)}${d.extra ? `, ${d.extra}` : ''}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="relative flex-1 min-w-0 h-full flex items-end justify-center"
              >
                {d.value > 0 && (
                  <span
                    aria-hidden
                    className={`chart-bar w-full min-h-(--mark-gap) transition-colors ${active === null || active === i ? 'bg-accent' : 'bg-accent-wash'}`}
                    style={{ height: `${pct}%` }}
                  />
                )}
                {i === peak && d.value > 0 && active === null && (
                  <span
                    aria-hidden
                    className={`absolute text-xs font-bold text-ink whitespace-nowrap ${edge(i) === 'left' ? 'left-0' : edge(i) === 'right' ? 'right-0' : ''}`}
                    style={{ bottom: `calc(${pct}% + var(--space) / 2)` }}
                  >
                    {format(d.value)}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {shown && active !== null && (
          <div
            aria-hidden
            className={`absolute top-0 z-10 pointer-events-none bg-ink text-surface rounded-md px-1 py-px text-sm whitespace-nowrap ${
              align === 'left' ? '' : align === 'right' ? '-translate-x-full' : '-translate-x-1/2'
            }`}
            style={{ left: `${((active + anchor) / data.length) * 100}%` }}
          >
            <span className="block font-bold">{shown.detail}</span>
            <span className="block">
              {format(shown.value)}
              {shown.extra && <span> · {shown.extra}</span>}
            </span>
          </div>
        )}
      </div>

      {/* x-axis */}
      <span aria-hidden />
      <div aria-hidden className="flex gap-(--mark-gap) pt-1 text-xs text-muted">
        {data.map((d, i) => (
          <span key={d.key} className="flex-1 min-w-0 flex justify-center whitespace-nowrap">
            {i % labelEvery === 0 ? d.label : ''}
          </span>
        ))}
      </div>
    </figure>
  );
}
