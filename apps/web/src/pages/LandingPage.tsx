import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EventCard } from '../components/EventCard';
import { EmptyState, ErrorState, LoadingState } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { EventSummary } from '../lib/types';

const band = 'max-w-content mx-auto px-2';
const pill = 'inline-flex items-center min-h-6 px-3 rounded-pill font-bold transition-colors';

// ---- hero illustration: a small venue whose seats get taken while you watch ----

const DEMO_ROWS = ['A', 'B', 'C', 'D', 'E'];
const DEMO_COLS = 8;
/** Seats that cycle available -> picked -> sold, with their start offsets in seconds. */
const LIVE: Record<string, number> = { A3: 0, A6: 4.5, B2: 1.5, B5: 6, C4: 3, C7: 7.5, D1: 2, D6: 5, E3: 8, E8: 3.5 };
const SOLD = new Set(['A4', 'A5', 'B4', 'C1', 'C2', 'D4', 'D5', 'E5']);
const HELD = new Set(['B7', 'B8', 'E1']);

function SeatDemo() {
  return (
    <div aria-hidden className="bg-surface border border-rule rounded-lg p-2 md:p-3 flex flex-col items-center gap-2 select-none">
      <div className="stage w-3/4 bg-ink text-surface text-xs font-bold tracking-widest text-center py-1">STAGE</div>
      <div className="flex flex-col gap-(--seat-gap)">
        {DEMO_ROWS.map((row) => (
          <div key={row} className="flex items-center gap-(--seat-gap)">
            <span className="w-2 text-xs font-bold text-muted">{row}</span>
            {Array.from({ length: DEMO_COLS }, (_, i) => {
              const label = `${row}${i + 1}`;
              const delay = LIVE[label];
              const state = SOLD.has(label) ? 'SOLD' : HELD.has(label) ? 'HELD' : 'AVAILABLE';
              return (
                <span
                  key={label}
                  data-state={state}
                  className={`seat ${delay !== undefined ? 'seat-demo' : ''}`}
                  style={delay !== undefined ? { animationDelay: `${delay}s` } : undefined}
                >
                  {i + 1}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <ul className="flex flex-wrap justify-center gap-x-2 gap-y-1 text-xs text-ink-soft">
        <li className="flex items-center gap-1">
          <span data-state="AVAILABLE" className="seat size-2" /> Open
        </li>
        <li className="flex items-center gap-1">
          <span data-state="HELD" className="seat size-2" /> Held
        </li>
        <li className="flex items-center gap-1">
          <span data-state="SOLD" className="seat size-2" /> Sold
        </li>
      </ul>
    </div>
  );
}

// ---- sections ----

function Hero() {
  const { user } = useAuth();
  const isOrganizer = user?.role === 'organizer' || user?.role === 'admin';
  return (
    <section className="border-b border-rule">
      <div className={`${band} py-6 md:py-8 grid gap-4 md:grid-cols-[1.1fr_1fr] md:items-center`}>
        <div className="flex flex-col gap-3 items-start">
          <p className="inline-flex items-center gap-1 px-1 rounded-sm bg-go-wash text-go text-sm font-bold">
            <span aria-hidden className="size-1 rounded-pill bg-go animate-pulse" />
            Live seat maps · 10-minute holds
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold">
            Every seat, sold <span className="text-accent">exactly once.</span>
          </h1>
          <p className="text-lg text-ink-soft max-w-measure">
            Pick your exact seat on a live venue plan. We hold it for 10 minutes while you pay, then your PDF tickets land in your inbox. No
            double bookings, even when a thousand people click at once.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link to="/events" className={`${pill} bg-accent text-accent-ink hover:bg-accent-deep`}>
              Browse events
            </Link>
            <Link
              to={isOrganizer ? '/organizer' : '/register?role=organizer'}
              className={`${pill} bg-surface text-ink border border-ink hover:bg-paper`}
            >
              {isOrganizer ? 'Open your dashboard' : 'Sell tickets'}
            </Link>
          </div>
        </div>
        <SeatDemo />
      </div>
    </section>
  );
}

const FACTS: { figure: string; text: string }[] = [
  { figure: '1', text: 'buyer per seat, guaranteed by the database' },
  { figure: '10 min', text: 'to pay while your seats are held' },
  { figure: '1×', text: 'charge per order, however often the bank retries' },
  { figure: 'PDF + QR', text: 'tickets, scanned once at the gate' },
];

function Facts() {
  return (
    <section aria-label="Guarantees" className="bg-ink text-surface">
      <dl className={`${band} py-4 grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-3`}>
        {FACTS.map((f) => (
          <div key={f.figure} className="flex flex-col gap-px">
            <dt className="font-bold text-xl md:text-2xl">{f.figure}</dt>
            <dd className="text-sm opacity-80">{f.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function OnSaleNow() {
  const events = useQuery({
    queryKey: ['events'],
    queryFn: ({ signal }) => api<{ events: EventSummary[] }>('/events?limit=50', { signal }),
  });
  return (
    <section aria-labelledby="on-sale" className={`${band} py-6 flex flex-col gap-3`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="on-sale" className="text-2xl font-extrabold">
          On sale now
        </h2>
        <Link to="/events" className="font-bold underline underline-offset-4">
          All events
        </Link>
      </div>
      {events.isPending ? (
        <LoadingState label="Loading events" />
      ) : events.isError ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : events.data.events.length === 0 ? (
        <EmptyState title="Nothing on sale right now">New events appear here as soon as organizers publish them.</EmptyState>
      ) : (
        <ul className="grid gap-2 md:grid-cols-3">
          {events.data.events.slice(0, 3).map((e) => (
            <li key={e.id} className="grid">
              <EventCard event={e} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const STEPS: { title: string; text: string }[] = [
  { title: 'Pick your seats', text: 'See the whole venue live. Seats others are holding show up hatched, sold ones crossed out, the moment it happens.' },
  { title: 'Hold for 10 minutes', text: 'Your seats are yours while the timer runs. If someone else got there first, we tell you which seat and keep the rest.' },
  { title: 'Pay and get tickets', text: 'Payment confirms in seconds. A PDF with a one-time QR code per seat arrives by email and in My tickets.' },
];

function HowItWorks() {
  return (
    <section aria-labelledby="how" className="bg-surface border-y border-rule">
      <div className={`${band} py-6 flex flex-col gap-3`}>
        <h2 id="how" className="text-2xl font-extrabold">
          How booking works
        </h2>
        <ol className="grid gap-3 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-1">
              <span aria-hidden className="size-5 grid place-items-center rounded-pill bg-accent-wash text-accent-deep font-display font-extrabold text-lg">
                {i + 1}
              </span>
              <h3 className="text-lg font-bold">{s.title}</h3>
              <p className="text-ink-soft">{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** A wordless sketch of the organizer dashboard: shapes only, no made-up figures. */
function DashboardSketch() {
  const columns = [3, 5, 4, 7, 6, 9, 8, 12, 10, 14, 13, 16];
  const meters = [
    { sold: 72, held: 8 },
    { sold: 45, held: 5 },
    { sold: 18, held: 2 },
  ];
  return (
    <div aria-hidden className="bg-surface border border-rule rounded-lg p-2 md:p-3 flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-1">
        {['Revenue', 'Tickets', 'Sell-through'].map((t) => (
          <div key={t} className="rounded-md border border-rule p-1 flex flex-col gap-1">
            <span className="text-xs text-muted">{t}</span>
            <span className="h-2 w-3/4 rounded-sm bg-ink" />
          </div>
        ))}
      </div>
      <div className="h-12 flex items-end gap-(--mark-gap) border-b border-rule">
        {columns.map((c, i) => (
          <span key={i} className="chart-bar flex-1 bg-accent" style={{ height: `${(c / 16) * 100}%` }} />
        ))}
      </div>
      {meters.map((m, i) => (
        <div key={i} className="meter flex">
          <span className="bg-accent" style={{ flexGrow: m.sold }} />
          <span className="hatch-accent" style={{ flexGrow: m.held }} />
          <span className="bg-rule" style={{ flexGrow: 100 - m.sold - m.held }} />
        </div>
      ))}
    </div>
  );
}

const ORGANIZER_POINTS = [
  'Revenue by day, sell-through per event and sales by tier, updated live',
  'Lay out rows and tiers, preview the seat map, publish when ready',
  'Holds that lapse release their seats automatically, even if a server dies',
  'Duplicate or late payment notices settle once, or refund the customer',
];

function ForOrganizers() {
  const { user } = useAuth();
  const isOrganizer = user?.role === 'organizer' || user?.role === 'admin';
  return (
    <section aria-labelledby="organizers" className={`${band} py-6 grid gap-4 md:grid-cols-2 md:items-center`}>
      <div className="flex flex-col gap-2 items-start">
        <p className="text-sm font-bold text-accent-deep uppercase tracking-wide">For organizers</p>
        <h2 id="organizers" className="text-2xl md:text-3xl font-extrabold">
          A box office that can’t oversell.
        </h2>
        <ul className="flex flex-col gap-1">
          {ORGANIZER_POINTS.map((p) => (
            <li key={p} className="flex gap-1 text-ink-soft">
              <span aria-hidden className="text-go font-bold">
                ✓
              </span>
              {p}
            </li>
          ))}
        </ul>
        <Link to={isOrganizer ? '/organizer' : '/register?role=organizer'} className={`${pill} bg-ink text-surface hover:bg-ink-soft`}>
          {isOrganizer ? 'Open your dashboard' : 'Start selling'}
        </Link>
      </div>
      <DashboardSketch />
    </section>
  );
}

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: 'What happens if two people pick the same seat?',
    a: 'Exactly one of them gets it. The other is told which seat was just taken, and any other seats they picked stay selected so they can choose again.',
  },
  {
    q: 'How long are my seats held?',
    a: 'Ten minutes from when you hold them. The checkout page shows a countdown; if it runs out, the seats go back on sale.',
  },
  {
    q: 'What if my payment goes through after the hold ran out?',
    a: 'If your seats are still free, you get them. If someone else bought them in the meantime, you’re refunded automatically.',
  },
  {
    q: 'Where are my tickets?',
    a: 'In My tickets as soon as payment confirms, with a PDF per seat, and in your email. Each QR code admits one person, once.',
  },
];

function Faq() {
  return (
    <section aria-labelledby="faq" className="bg-surface border-t border-rule">
      <div className={`${band} py-6 grid gap-3 md:grid-cols-[1fr_2fr]`}>
        <h2 id="faq" className="text-2xl font-extrabold">
          Questions
        </h2>
        <div className="flex flex-col">
          {FAQ.map((item) => (
            <details key={item.q} className="group border-t border-rule last:border-b py-2">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-2 font-bold text-lg">
                {item.q}
                <span aria-hidden className="text-accent text-xl transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="pt-1 text-ink-soft max-w-measure">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function LandingPage() {
  return (
    <>
      <Hero />
      <Facts />
      <OnSaleNow />
      <HowItWorks />
      <ForOrganizers />
      <Faq />
    </>
  );
}
