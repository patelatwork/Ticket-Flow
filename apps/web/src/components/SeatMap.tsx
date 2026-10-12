import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatPaise, splitLabel } from '../lib/format';
import type { Seat } from '../lib/types';

type VisualState = Seat['state'] | 'SELECTED' | 'CONFLICT';

const stateWords: Record<VisualState, string> = {
  AVAILABLE: 'available',
  SELECTED: 'selected',
  HELD: 'held by someone else',
  SOLD: 'sold',
  CONFLICT: 'just taken by someone else',
};

interface Row {
  name: string;
  tier: string;
  pricePaise: number;
  seats: Seat[];
}

function toRows(seats: Seat[]): Row[] {
  const byRow = new Map<string, Seat[]>();
  for (const seat of seats) {
    const { row } = splitLabel(seat.label);
    const list = byRow.get(row) ?? [];
    list.push(seat);
    byRow.set(row, list);
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([name, list]) => {
      const sorted = list.sort((a, b) => splitLabel(a.label).num - splitLabel(b.label).num);
      const first = sorted[0];
      return { name, tier: first?.tier ?? '', pricePaise: first?.pricePaise ?? 0, seats: sorted };
    });
}

export interface SeatMapProps {
  seats: Seat[];
  selected: ReadonlySet<string>;
  /** Seats the API just rejected with 409; highlighted until the user acts again. */
  conflicts: ReadonlySet<string>;
  onToggle: (seat: Seat) => void;
}

/**
 * The venue plan. Keyboard: Tab enters the map once (roving tabindex), arrow keys move
 * between seats, Home/End jump within a row, Space/Enter selects. Every seat button
 * announces label, tier, price and state; unavailable seats stay focusable (aria-disabled)
 * so they can be explored. State is shown by shape/pattern as well as color.
 */
export function SeatMap({ seats, selected, conflicts, onToggle }: SeatMapProps) {
  const rows = useMemo(() => toRows(seats), [seats]);
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const activeId = focusId ?? rows[0]?.seats[0]?.id;

  const visual = (seat: Seat): VisualState => {
    if (conflicts.has(seat.id)) return 'CONFLICT';
    if (selected.has(seat.id)) return 'SELECTED';
    return seat.state;
  };

  const move = (rowIdx: number, seatIdx: number): void => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, rowIdx))];
    if (!row) return;
    const seat = row.seats[Math.max(0, Math.min(row.seats.length - 1, seatIdx))];
    if (!seat) return;
    setFocusId(seat.id);
    refs.current.get(seat.id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, rowIdx: number, seatIdx: number): void => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => { move(rowIdx, seatIdx + 1); },
      ArrowLeft: () => { move(rowIdx, seatIdx - 1); },
      ArrowDown: () => { move(rowIdx + 1, seatIdx); },
      ArrowUp: () => { move(rowIdx - 1, seatIdx); },
      Home: () => { move(rowIdx, 0); },
      End: () => { move(rowIdx, Number.MAX_SAFE_INTEGER); },
    };
    const action = keys[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto pb-1">
        <div className="min-w-max mx-auto flex flex-col items-center gap-1 px-1">
          <div className="stage w-full max-w-measure bg-ink text-paper text-center text-sm font-bold py-1 mb-2" aria-hidden>
            Stage
          </div>
          <div role="grid" aria-label="Seat map. Use arrow keys to move between seats and Space to select." className="flex flex-col gap-1">
            {rows.map((row, rowIdx) => {
              const newTier = rowIdx === 0 || rows[rowIdx - 1]?.tier !== row.tier;
              return (
                <div key={row.name} role="presentation" className="flex flex-col gap-1">
                  {newTier && (
                    <p className="text-sm text-ink-soft mt-1" role="presentation">
                      <span className="font-bold text-ink">{row.tier}</span> {formatPaise(row.pricePaise)}
                    </p>
                  )}
                  <div role="row" className="flex items-center gap-1">
                    <span role="rowheader" className="w-3 text-sm font-bold text-muted text-right">
                      {row.name}
                    </span>
                    <div className="flex" style={{ gap: 'var(--seat-gap)' }}>
                      {row.seats.map((seat, seatIdx) => {
                        const state = visual(seat);
                        const unavailable = state === 'HELD' || state === 'SOLD' || state === 'CONFLICT';
                        return (
                          <span role="gridcell" key={seat.id}>
                            <button
                              ref={(el) => {
                                if (el) refs.current.set(seat.id, el);
                                else refs.current.delete(seat.id);
                              }}
                              type="button"
                              className="seat"
                              data-state={state}
                              tabIndex={seat.id === activeId ? 0 : -1}
                              aria-pressed={state === 'SELECTED'}
                              aria-disabled={unavailable || undefined}
                              aria-label={`Seat ${seat.label}, ${seat.tier}, ${formatPaise(seat.pricePaise)}, ${stateWords[state]}`}
                              title={`${seat.label}, ${seat.tier}, ${formatPaise(seat.pricePaise)}`}
                              onFocus={() => {
                                setFocusId(seat.id);
                              }}
                              onKeyDown={(e) => {
                                onKeyDown(e, rowIdx, seatIdx);
                              }}
                              onClick={() => {
                                if (!unavailable) onToggle(seat);
                              }}
                            >
                              <span aria-hidden>{state === 'SELECTED' ? '✓' : splitLabel(seat.label).num || seat.label}</span>
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <SeatLegend />
    </div>
  );
}

function SeatLegend() {
  const items: { state: VisualState; text: string }[] = [
    { state: 'AVAILABLE', text: 'Available' },
    { state: 'SELECTED', text: 'Your pick' },
    { state: 'HELD', text: 'On hold' },
    { state: 'SOLD', text: 'Sold' },
  ];
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 justify-center text-sm text-ink-soft" aria-label="Legend">
      {items.map((item) => (
        <li key={item.state} className="flex items-center gap-1">
          <span className="seat" data-state={item.state} aria-hidden style={{ cursor: 'default' }}>
            {item.state === 'SELECTED' ? '✓' : ''}
          </span>
          {item.text}
        </li>
      ))}
    </ul>
  );
}
