import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { formatPaise } from '../../lib/format';
import { Button, Field, errorMessage } from '../ui';

const ROW_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Builds labels like A1..A10, B1..B10 for `rows` rows starting at `firstRow`. */
function buildSeats(firstRow: string, rows: number, perRow: number, tier: string, pricePaise: number) {
  const start = ROW_LETTERS.indexOf(firstRow.toUpperCase());
  const letters = ROW_LETTERS.slice(start, start + rows).split('');
  return letters.flatMap((row) => Array.from({ length: perRow }, (_, i) => ({ label: `${row}${i + 1}`, tier, pricePaise })));
}

/** Adds a block of identical rows (one tier) to an event. Repeat for each tier. */
export function SeatLayoutForm({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient();
  const [firstRow, setFirstRow] = useState('A');
  const [rows, setRows] = useState('2');
  const [perRow, setPerRow] = useState('10');
  const [tier, setTier] = useState('Standard');
  const [priceRupees, setPriceRupees] = useState('500');

  const rowCount = Number(rows);
  const seatsPerRow = Number(perRow);
  const pricePaise = Math.round(Number(priceRupees) * 100);
  const startIdx = ROW_LETTERS.indexOf(firstRow.toUpperCase());
  const invalid =
    startIdx < 0 || !Number.isInteger(rowCount) || rowCount < 1 || startIdx + rowCount > 26 || !Number.isInteger(seatsPerRow) || seatsPerRow < 1 || seatsPerRow > 50 || !(pricePaise > 0) || !tier.trim();

  const add = useMutation({
    mutationFn: () =>
      api(`/events/${eventId}/seats`, { method: 'POST', body: { seats: buildSeats(firstRow, rowCount, seatsPerRow, tier.trim(), pricePaise) } }),
    onSuccess: () => {
      setFirstRow(ROW_LETTERS[startIdx + rowCount] ?? 'A');
      void queryClient.invalidateQueries({ queryKey: ['my-events'] });
      void queryClient.invalidateQueries({ queryKey: ['seat-map', eventId] });
    },
  });

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!invalid) add.mutate();
  };

  const lastRow = ROW_LETTERS[startIdx + rowCount - 1] ?? '?';
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" aria-label="Add seats">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Field label="First row" value={firstRow} maxLength={1} onChange={(e) => setFirstRow(e.target.value.toUpperCase())} />
        <Field label="Rows" type="number" min={1} max={26} value={rows} onChange={(e) => setRows(e.target.value)} />
        <Field label="Seats per row" type="number" min={1} max={50} value={perRow} onChange={(e) => setPerRow(e.target.value)} />
        <Field label="Tier" value={tier} onChange={(e) => setTier(e.target.value)} />
        <Field label="Price (₹)" type="number" min={1} step="0.01" value={priceRupees} onChange={(e) => setPriceRupees(e.target.value)} />
      </div>
      <p className="text-sm text-ink-soft" aria-live="polite">
        {invalid
          ? 'Rows run A to Z, up to 50 seats per row, and the price must be above zero.'
          : `Adds rows ${firstRow}–${lastRow}: ${rowCount * seatsPerRow} ${tier} seats at ${formatPaise(pricePaise)}.`}
      </p>
      {add.isError && (
        <p role="alert" className="text-accent-deep">
          {errorMessage(add.error)}
        </p>
      )}
      <Button type="submit" variant="secondary" disabled={invalid || add.isPending} className="self-start">
        {add.isPending ? 'Adding…' : 'Add seats'}
      </Button>
    </form>
  );
}
