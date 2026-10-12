const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Integer paise to "₹1,250" / "₹1,250.5". */
export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'short' });

export function formatDateTime(iso: string): string {
  return dateTimeFmt.format(new Date(iso));
}

export function dayAndMonth(iso: string): { day: string; month: string } {
  const d = new Date(iso);
  return { day: dayFmt.format(d), month: monthFmt.format(d) };
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Splits "A10" into row "A" and number 10, for natural seat ordering. */
export function splitLabel(label: string): { row: string; num: number } {
  const match = /^([^0-9]*)(\d*)/.exec(label);
  const row = match?.[1] ?? '';
  return { row: row === '' ? label : row, num: Number(match?.[2] ?? 0) };
}
