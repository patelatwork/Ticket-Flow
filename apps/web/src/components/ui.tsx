import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useId } from 'react';
import { ApiError } from '../lib/api';
import type { BookingStatus } from '../lib/types';

type Variant = 'primary' | 'secondary' | 'quiet';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-deep disabled:bg-rule disabled:text-muted',
  secondary: 'bg-surface text-ink border border-ink hover:bg-paper disabled:text-muted disabled:border-rule',
  quiet: 'text-ink-soft underline underline-offset-4 hover:text-ink disabled:text-muted',
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const shape = variant === 'quiet' ? 'px-0' : 'px-3 py-1 rounded-pill';
  return (
    <button
      type="button"
      {...props}
      className={`${shape} min-h-6 font-bold text-base transition-colors disabled:transition-none disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  error,
  hint,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined; hint?: string }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-bold text-sm">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
        className="min-h-6 px-2 rounded-md border border-rule bg-surface text-base aria-invalid:border-accent-deep"
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-accent-deep">
          {error}
        </p>
      )}
    </div>
  );
}

export function SelectField({ label, children, ...select }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-bold text-sm">
        {label}
      </label>
      <select id={id} {...select} className="min-h-6 px-2 rounded-md border border-rule bg-surface text-base">
        {children}
      </select>
    </div>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="flex flex-col gap-1 mb-4">
      <h1 className="text-2xl md:text-3xl font-extrabold">{children}</h1>
      {sub && <p className="text-ink-soft max-w-measure">{sub}</p>}
    </header>
  );
}

// ---- data states: every data view renders one of these when it isn't showing data ----

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="py-6 flex items-center gap-2 text-muted">
      <span aria-hidden className="size-2 rounded-pill bg-accent animate-pulse" />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="py-6 flex flex-col gap-2 items-start max-w-measure">
      <h2 className="text-lg font-bold">{title}</h2>
      {children && <p className="text-ink-soft">{children}</p>}
      {action}
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Try again.';
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <div role="alert" className="py-6 flex flex-col gap-2 items-start max-w-measure">
      <h2 className="text-lg font-bold">{notFound ? 'Not found' : 'Couldn’t load this'}</h2>
      <p className="text-ink-soft">{notFound ? 'It may have been removed, or the link is wrong.' : errorMessage(error)}</p>
      {onRetry && !notFound && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** For 409s: someone else changed the thing we acted on. Says what happened and what to do. */
export function ConflictNotice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="p-2 rounded-md border-2 border-dashed border-accent-deep bg-accent-wash flex flex-col gap-1">
      <p className="font-bold text-accent-deep">{title}</p>
      <div className="text-ink-soft">{children}</div>
      {action}
    </div>
  );
}

const statusText: Record<BookingStatus, string> = {
  HELD: 'Seats held',
  PAID: 'Paid',
  EXPIRED: 'Hold expired',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const tone =
    status === 'PAID' ? 'bg-go-wash text-go border-go' : status === 'HELD' ? 'bg-accent-wash text-accent-deep border-accent' : 'bg-paper text-muted border-rule';
  return <span className={`inline-flex px-1 rounded-sm border text-sm font-bold ${tone}`}>{statusText[status]}</span>;
}
