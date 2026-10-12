import type { ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router';
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
            <NavLink to="/" end className={navClass}>
              Events
            </NavLink>
            {user && (
              <NavLink to="/me/bookings" className={navClass}>
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
              <NavLink to="/login" className={navClass}>
                Sign in
              </NavLink>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className="flex-1 w-full max-w-content mx-auto px-2 py-4">
        <Outlet />
      </main>
    </div>
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
