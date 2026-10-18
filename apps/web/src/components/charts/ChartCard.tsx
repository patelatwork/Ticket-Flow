import { useId, useState, type ReactNode } from 'react';

/**
 * A titled dashboard panel. When `table` is given the panel offers a Chart / Table switch:
 * the table is the accessible twin of the chart, so no value is ever tooltip-only.
 */
export function ChartCard({
  title,
  sub,
  children,
  table,
  className = '',
}: {
  title: string;
  sub?: ReactNode;
  children: ReactNode;
  table?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <section aria-labelledby={id} className={`bg-surface border border-rule rounded-lg p-2 md:p-3 flex flex-col gap-2 min-w-0 ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="flex flex-col min-w-0">
          <h2 id={id} className="text-lg font-bold">
            {title}
          </h2>
          {sub && <p className="text-sm text-ink-soft">{sub}</p>}
        </div>
        {table && (
          <div role="group" aria-label={`${title} view`} className="flex rounded-pill border border-rule p-px text-sm font-bold">
            {(['chart', 'table'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className="px-2 py-px rounded-pill text-ink-soft aria-pressed:bg-ink aria-pressed:text-surface"
              >
                {v === 'chart' ? 'Chart' : 'Table'}
              </button>
            ))}
          </div>
        )}
      </header>
      {table && view === 'table' ? <div className="overflow-x-auto">{table}</div> : children}
    </section>
  );
}

const th = 'text-left font-bold text-sm text-ink-soft py-1 pr-2 border-b border-rule whitespace-nowrap';
const td = 'py-1 pr-2 border-b border-rule tabular-nums whitespace-nowrap';

/** A plain data table for a ChartCard's table view. First column is the row header. */
export function DataTable({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col" className={th}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[0])}>
            {row.map((cell, i) =>
              i === 0 ? (
                <th key={i} scope="row" className={`${td} font-normal text-left`}>
                  {cell}
                </th>
              ) : (
                <td key={i} className={td}>
                  {cell}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
