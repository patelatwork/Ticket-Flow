/**
 * Sold / held / available as one bar. Held is hatched and available is the bare track, so the
 * three states differ by texture as well as color. Segments are split by a surface gap.
 */
export function StackMeter({ sold, held, total, label }: { sold: number; held: number; total: number; label: string }) {
  const available = Math.max(0, total - sold - held);
  const parts = [
    { key: 'sold', n: sold, className: 'bg-accent', word: 'sold' },
    { key: 'held', n: held, className: 'hatch-accent', word: 'on hold' },
    { key: 'available', n: available, className: 'bg-rule', word: 'available' },
  ].filter((p) => p.n > 0);
  return (
    <div role="img" aria-label={`${label}: ${sold} sold, ${held} on hold, ${available} available, of ${total}`} className="meter flex w-full">
      {parts.map((p) => (
        <span key={p.key} title={`${p.n} ${p.word}`} className={`${p.className} min-w-(--mark-gap)`} style={{ flexGrow: p.n, flexBasis: 0 }} />
      ))}
      {total === 0 && <span className="bg-rule w-full" />}
    </div>
  );
}

export function MeterLegend() {
  const items = [
    { key: 'sold', className: 'bg-accent', word: 'Sold' },
    { key: 'held', className: 'hatch-accent', word: 'On hold' },
    { key: 'available', className: 'bg-rule', word: 'Available' },
  ];
  return (
    <ul aria-label="Legend" className="flex flex-wrap gap-x-2 gap-y-1 text-sm text-ink-soft">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-1">
          <span aria-hidden className={`inline-block size-2 rounded-sm ${i.className}`} />
          {i.word}
        </li>
      ))}
    </ul>
  );
}
