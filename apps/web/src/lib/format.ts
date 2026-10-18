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

const compactInr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 });
const compactNum = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });

/** Integer paise to "₹2.5K" / "₹1.2L", for axis ticks and tight tiles. */
export function formatPaiseCompact(paise: number): string {
  return compactInr.format(paise / 100);
}

export function formatCompact(n: number): string {
  return compactNum.format(n);
}

/** 0.4567 -> "46%". */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

const shortDayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const monthYearFmt = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' });

/** "2026-10-18" (a UTC calendar day) -> "18 Oct" / "Sun, 18 Oct". */
export function formatDay(isoDay: string, long = false): string {
  return (long ? longDayFmt : shortDayFmt).format(new Date(`${isoDay}T00:00:00Z`));
}

export function formatMonthYear(date: Date): string {
  return monthYearFmt.format(date);
}

const relative = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });

/** "in 3 days" / "tomorrow" / "in 5 hours" / "2 minutes ago". */
export function formatRelative(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  if (abs < 3_600_000) return relative.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return relative.format(Math.round(diff / 3_600_000), 'hour');
  return relative.format(Math.round(diff / 86_400_000), 'day');
}

/** The smallest "nice" number (1, 2, 2.5, 5 x 10^n) at or above `n`, for axis maxima. */
export function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= n) ?? 10;
  return step * pow;
}
