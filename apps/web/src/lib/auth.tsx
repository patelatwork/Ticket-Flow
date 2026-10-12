import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onSessionChange, refreshSession, setAccessToken } from './api';
import type { User } from './types';

export type SignupRole = 'attendee' | 'organizer';

interface AuthState {
  user: User | null;
  /** True until the initial cookie-based session restore has finished. */
  restoring: boolean;
  login(email: string, password: string): Promise<User>;
  register(email: string, password: string, role: SignupRole): Promise<User>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

interface SessionResponse {
  user: User;
  accessToken: string;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    // Restore the session from the httpOnly refresh cookie on page load.
    void (async () => {
      const token = await refreshSession();
      if (token && !cancelled) {
        try {
          const me = await api<{ user: User }>('/auth/me');
          if (!cancelled) setUser(me.user);
        } catch {
          // Treated as signed out.
        }
      }
      if (!cancelled) setRestoring(false);
    })();
    const off = onSessionChange((token) => {
      if (!token) setUser(null);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const start = useCallback((res: SessionResponse): User => {
    setAccessToken(res.accessToken);
    setUser(res.user);
    return res.user;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      restoring,
      login: async (email, password) => start(await api<SessionResponse>('/auth/login', { method: 'POST', body: { email, password } })),
      register: async (email, password, role) =>
        start(await api<SessionResponse>('/auth/register', { method: 'POST', body: { email, password, role } })),
      logout: async () => {
        try {
          await api('/auth/logout', { method: 'POST' });
        } finally {
          setAccessToken(null);
          setUser(null);
          queryClient.clear();
        }
      },
    }),
    [user, restoring, start, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
