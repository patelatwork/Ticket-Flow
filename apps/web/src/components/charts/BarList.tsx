import type { ReactNode } from 'react';

export interface BarRow {
  key: string;
  label: ReactNode;
  sub?: ReactNode;
  value: number;
  /** The text shown at the bar tip. */
  display: string;
}

/**
 * Horizontal single-series bars, each value labelled at its tip, so nothing hides behind hover.
 * Bars scale to the largest row unless `max` is given (e.g. 1 for fractions of a whole).
 */
export function BarList({ rows, label, max: fixedMax }: { rows: BarRow[]; label: string; max?: number }) {
  const max = fixedMax ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,7rem)_1fr] md:grid-cols-[minmax(0,10rem)_1fr] items-center gap-x-2">
          <span className="flex flex-col min-w-0 leading-tight">
            <span className="font-bold truncate">{r.label}</span>
            {r.sub && <span className="text-xs text-muted">{r.sub}</span>}
          </span>
          <span className="flex items-center gap-1 min-w-0">
            <span className="flex-1 min-w-0 flex">
              {r.value > 0 && <span aria-hidden className="block h-(--meter-h) rounded-r-sm bg-accent min-w-(--mark-gap)" style={{ width: `${(r.value / max) * 100}%` }} />}
            </span>
            <span className="text-sm font-bold tabular-nums whitespace-nowrap">{r.display}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
