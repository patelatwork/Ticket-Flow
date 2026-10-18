import type { ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, type To } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Role } from '../lib/types';
import { LoadingState } from './ui';

/** Bull Board can't send our bearer token, so trade it for a short-lived /admin cookie first. */
async function openQueueBoard(): Promise<void> {
  await api('/admin/session', { method: 'POST' });
  // Same-tab navigation: a window.open after an await would be blocked as a popup.
  window.location.assign('/admin/queues');
}

function navClass({ isActive }: { isActive: boolean }): string {
  return `py-1 border-b-2 ${isActive ? 'border-accent text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`;
}

export function Layout() {
  const { user, logout } = useAuth();
  // The landing page lays out its own full-width bands; every other page sits in the column.
  const fullBleed = useLocation().pathname === '/';
  return (
    <div className="min-h-dvh flex flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:p-2 focus:bg-surface">
        Skip to content
      </a>
      <header className="border-b border-rule bg-surface">
        <div className="max-w-content mx-auto px-2 py-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link to="/" className="font-display font-extrabold text-lg mr-auto">
            Ticket<span className="text-accent">Flow</span>
          </Link>
          <nav aria-label="Main" className="flex flex-wrap items-center gap-x-3 text-sm font-bold">
            <NavLink to="/events" className={navClass}>
              Events
            </NavLink>
            {user && (
              <NavLink to="/me" className={navClass}>
                My tickets
              </NavLink>
            )}
            {(user?.role === 'organizer' || user?.role === 'admin') && (
              <NavLink to="/organizer" className={navClass}>
                Organizer
              </NavLink>
            )}
            {user?.role === 'admin' && (
              <button type="button" onClick={() => void openQueueBoard()} className="py-1 text-ink-soft hover:text-ink">
                Queues
              </button>
            )}
            {user ? (
              <button type="button" onClick={() => void logout()} className="py-1 text-ink-soft hover:text-ink">
                Sign out
              </button>
            ) : (
              <>
                <NavLink to="/login" className={navClass}>
                  Sign in
                </NavLink>
                <Link to="/register" className="px-2 py-px rounded-pill bg-ink text-surface hover:bg-ink-soft">
                  Get started
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className={fullBleed ? 'flex-1 w-full' : 'flex-1 w-full max-w-content mx-auto px-2 py-4'}>
        <Outlet />
      </main>
      <footer className="border-t border-rule bg-surface">
        <div className="max-w-content mx-auto px-2 py-3 flex flex-wrap items-baseline justify-between gap-2 text-sm text-ink-soft">
          <p>
            <span className="font-display font-extrabold text-ink">
              Ticket<span className="text-accent">Flow</span>
            </span>{' '}
            · Every seat, sold exactly once.
          </p>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-3 gap-y-1">
            <Link to="/events" className="hover:text-ink">
              Browse events
            </Link>
            <Link to={user ? '/organizer' : '/register?role=organizer'} className="hover:text-ink">
              Sell tickets
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** Tabs between the pages of one section (e.g. Overview / Tickets). */
export function SubNav({ label, items }: { label: string; items: { to: To; label: string; end?: boolean }[] }) {
  return (
    <nav aria-label={label} className="flex gap-3 border-b border-rule mb-4 text-sm font-bold overflow-x-auto">
      {items.map((item) => (
        <NavLink key={item.label} to={item.to} end={item.end} className={({ isActive }) => `-mb-px ${navClass({ isActive })}`}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Gate for signed-in (and optionally role-restricted) routes. */
export function RequireAuth({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user, restoring } = useAuth();
  const location = useLocation();
  if (restoring) return <LoadingState label="Checking your session" />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
