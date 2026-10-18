import type { ReactNode } from 'react';

/**
 * A number that doesn't need a chart; render inside a <dl>. `hero` is the one figure a
 * dashboard leads with. Proportional figures here: tabular-nums is for columns only.
 */
export function StatTile({ label, value, hint, hero = false }: { label: string; value: ReactNode; hint?: ReactNode; hero?: boolean }) {
  return (
    <div className={`bg-surface border border-rule rounded-lg p-2 flex flex-col gap-px min-w-0 ${hero ? 'md:p-3' : ''}`}>
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className={`font-bold leading-tight ${hero ? 'text-2xl md:text-3xl' : 'text-xl'}`}>{value}</dd>
      {hint && <dd className="text-sm text-muted">{hint}</dd>}
    </div>
  );
}
