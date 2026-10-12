/**
 * Fetch wrapper for the API (proxied at /api). Holds the access token in memory only; the
 * refresh token lives in an httpOnly cookie the page can't read. On an expired access
 * token it refreshes once (deduplicated across concurrent calls) and retries.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Seat ids from a 409 SEATS_UNAVAILABLE response. */
  get conflictingSeatIds(): string[] {
    const d = this.details as { seatIds?: unknown } | undefined;
    return Array.isArray(d?.seatIds) ? d.seatIds.filter((x): x is string => typeof x === 'string') : [];
  }
}

const BASE = '/api';
let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let clockOffsetMs = 0;
const sessionListeners = new Set<(token: string | null) => void>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const listener of sessionListeners) listener(token);
}

export function onSessionChange(listener: (token: string | null) => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

/** "Now" on the server's clock, for countdowns against hold_expires_at. */
export function serverNow(): number {
  return Date.now() + clockOffsetMs;
}

function trackClock(res: Response): void {
  const date = res.headers.get('date');
  if (!date) return;
  const server = Date.parse(date);
  // The Date header has 1s resolution; only correct skews larger than that.
  if (!Number.isNaN(server) && Math.abs(server - Date.now()) > 1500) clockOffsetMs = server - Date.now();
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    return new ApiError(res.status, body.error?.code ?? 'HTTP_ERROR', body.error?.message ?? res.statusText, body.error?.details);
  } catch {
    return new ApiError(res.status, 'HTTP_ERROR', res.statusText || 'Request failed');
  }
}

export function refreshSession(): Promise<string | null> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        setAccessToken(null);
        return null;
      }
      const body = (await res.json()) as { accessToken: string };
      setAccessToken(body.accessToken);
      return body.accessToken;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = (token: string | null): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      signal: options.signal,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  let res: Response;
  try {
    res = await send(accessToken);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Can’t reach TicketFlow. Check your connection and try again.');
  }
  trackClock(res);

  if (res.status === 401 && accessToken) {
    const fresh = await refreshSession();
    if (fresh) {
      res = await send(fresh);
      trackClock(res);
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
