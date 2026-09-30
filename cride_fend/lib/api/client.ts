import { ApiError } from './errors';
import type { components } from '../generated/api';

/**
 * The only way this app talks to the API.
 *
 * Three decisions, each of which the previous `lib/api.ts` got wrong:
 *
 * 1. It targets `/api/...`, the BFF in `app/api/[...path]/route.ts`, not
 *    `NEXT_PUBLIC_API_URL` directly. The API sets `cride.sid` and
 *    `cride.refresh` as HttpOnly cookies, and a cookie the browser will not send
 *    to `localhost:4000` because it is not the API's origin is a cookie that
 *    cannot work. The BFF is not a proxy for convenience; it is what makes
 *    cookie auth possible at all.
 *
 * 2. `credentials: 'include'`, always. Not conditionally.
 *
 * 3. It fails with `ApiError` or it does not return. There is no `any` and no
 *    partial-response path, so a caller cannot forget to check.
 *
 * The generated document describes the shapes; this file names the ones the app
 * actually uses, so a screen says `await api.rides.listAvailable()` rather than
 * hand-rolling a path and a cast.
 */

type Schemas = components['schemas'];
type Op<T extends keyof import('../generated/api').operations> = import('../generated/api').operations[T];

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  /** A correlation id to carry through the whole request. Generated if absent. */
  requestId?: string;
}

/** A page, plus the cursor plumbing. Mirrors the backend's keyset pagination exactly. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

const BASE = '/api';

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `web-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised ? `?${serialised}` : '';
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const url = `${BASE}${path}${buildQuery(options.query)}`;

  const headers: Record<string, string> = {
    // A browser form post, a fetch and a navigation all reach this one function.
    // Without this a PATCH from a form would arrive as a POST and a DELETE with a
    // body would be dropped.
    accept: 'application/json',
    'x-request-id': options.requestId ?? newRequestId(),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (cause) {
    // AbortError is the caller's own doing — a superseded query or an unmounted
    // screen. Rethrowing it keeps it out of every error boundary in the app.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw ApiError.network(cause);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // A proxy's HTML error page, not the API. Still an ApiError, never a crash
      // in a `.map()` somewhere far from the cause.
      if (!response.ok) {
        throw new ApiError({ status: response.status, code: 'UNEXPECTED_RESPONSE', message: 'Unexpected response.' });
      }
      throw new ApiError({
        status: response.status,
        code: 'UNEXPECTED_RESPONSE',
        message: 'C-Ride sent a response the app could not read.',
      });
    }
  }

  if (!response.ok) throw ApiError.from(response.status, payload);

  return payload as T;
}

/* ---------------------------------------------------------------------------
 * The API, as the app uses it.
 * ------------------------------------------------------------------------ */

export const api = {
  auth: {
    /** No `refreshToken` in the body — the cookie is the credential. §4.2. */
    login: (input: Op<'login'>['requestBody']['content']['application/json'], options?: RequestOptions) =>
      request<Schemas['AuthSessionResponseDto']>('POST', '/auth/login', input, options),

    register: (
      input: Op<'register'>['requestBody']['content']['application/json'],
      options?: RequestOptions,
    ) => request<Schemas['AuthSessionResponseDto']>('POST', '/auth/register', input, options),

    me: (options?: RequestOptions) => request<Schemas['PrincipalDto']>('GET', '/auth/me', undefined, options),

    /** Empty body by design: a browser has a cookie and no way to send a token. */
    refresh: (options?: RequestOptions) => request<Schemas['AuthSessionResponseDto']>('POST', '/auth/refresh', undefined, options),

    logout: (options?: RequestOptions) => request<{ revoked: boolean }>('POST', '/auth/logout', undefined, options),
  },

  rides: {
    request: (
      input: Op<'requestRide'>['requestBody']['content']['application/json'],
      options?: RequestOptions,
    ) => request<Schemas['RideResponseDto']>('POST', '/rides', input, options),

    /**
     * The ride *and* its event log. There is no separate `/events` route — the
     * detail response already carries `events` with the gapless per-ride `seq`,
     * so a separate fetch would be a second request for data already in hand.
     */
    get: (rideId: string, options?: RequestOptions) =>
      request<Schemas['RideDetailResponseDto']>('GET', `/rides/${encodeURIComponent(rideId)}`, undefined, options),

    /**
     * `/rides/history`, not `/rides` — the create endpoint owns that path, so a GET
     * there is a 404. Already scoped to the caller: a rider sees the rides they
     * requested, a driver the rides assigned to them, and someone else's ride is
     * indistinguishable from one that does not exist.
     *
     * `status` accepts a comma-separated list, which is how "what is my current
     * ride?" is answered in one request rather than three.
     */
    listHistory: async (options?: RequestOptions & { cursor?: string; limit?: number; status?: string }): Promise<Page<Schemas['RideResponseDto']>> => {
      const page = await request<Schemas['RideListResponseDto']>('GET', '/rides/history', undefined, {
        ...options,
        query: { cursor: options?.cursor, limit: options?.limit, status: options?.status },
      });
      return { items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
    },

    listAvailable: async (
      options?: RequestOptions & { cursor?: string; limit?: number; status?: string },
    ): Promise<Page<Schemas['RideResponseDto']>> => {
      const page = await request<Schemas['RideListResponseDto']>('GET', '/rides/available', undefined, {
        ...options,
        query: { cursor: options?.cursor, limit: options?.limit, status: options?.status },
      });
      return { items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
    },

    // PATCH, not POST — and not a guess. The generated document says `patch`, and
    // the earlier hand-written client said `POST`, which the router answered with
    // a 404 whose message ("Cannot POST /rides/…/accept") looked like a missing
    // backend feature rather than a wrong verb in the client.
    accept: (rideId: string, options?: RequestOptions) =>
      request<Schemas['RideResponseDto']>('PATCH', `/rides/${encodeURIComponent(rideId)}/accept`, {}, options),

    /**
     * §4.5.2c. `version` is what makes this safe: two drivers cannot both move a
     * ride forward. Omitting it opts into last-writer-wins, which the app never
     * does — the caller gets `version` from the ride it is acting on.
     */
    // The field is `to`, not `status`. That is what the backend's schema says, and
    // it is the kind of detail a hand-written client gets wrong: the old
    // `lib/api.ts` sent `{ status }`, so every transition 400'd with a MISSING_FIELD
    // issue the form never displayed. Generating the types is what caught it.
    transition: (
      rideId: string,
      input: Op<'transitionRide'>['requestBody']['content']['application/json'],
      options?: RequestOptions,
    ) => request<Schemas['RideResponseDto']>('PATCH', `/rides/${encodeURIComponent(rideId)}/status`, input, options),

    cancel: (rideId: string, version: number, reason?: string, options?: RequestOptions) =>
      request<Schemas['RideResponseDto']>('PATCH', `/rides/${encodeURIComponent(rideId)}/status`, {
        to: 'CANCELLED',
        version,
        ...(reason ? { reason } : {}),
      }, options),

  },

  driver: {
    availability: (options?: RequestOptions) =>
      request<{ driverId: string; isAvailable: boolean }>('GET', '/driver/availability', undefined, options),

    setAvailability: (isAvailable: boolean, options?: RequestOptions) =>
      request<{ driverId: string; isAvailable: boolean }>('PATCH', '/driver/availability', { isAvailable }, options),
  },

  devices: {
    list: (options?: RequestOptions) =>
      request<Op<'listMyDevices'>['responses']['200']['content']['application/json']>('GET', '/devices', undefined, options),

    register: (input: { token: string; platform?: 'web' | 'android' | 'ios' }, options?: RequestOptions) =>
      request<{ token: string; platform: string; pushEnabled: boolean }>('POST', '/devices', { platform: 'web', ...input }, options),

    /**
     * DELETE with a body. The token *is* the identifier, and it is only ever held
     * on the device, so making it a path segment would mean putting it in a URL
     * — where it lands in access logs, `Referer` headers and browser history.
     */
    revoke: (token: string, options?: RequestOptions) =>
      request<{ revoked: boolean }>('DELETE', '/devices', { token }, options),
  },

  notifications: {
    /**
     * Returns the response document as-is rather than reshaping it into `Page<T>`.
     *
     * Every other list here is reshaped because it is a bare
     * `{ items, nextCursor, hasMore }`. This one also carries `unreadCount`, and
     * dropping it to fit the shared shape would mean the panel makes a second
     * request for the badge — and the count it got could disagree with the list it
     * was rendered beside.
     *
     * The cursor is passed back exactly as received. It is opaque and base64url,
     * and re-deriving it from the page it came from is how a paginated list starts
     * silently repeating page one.
     */
    list: (options?: RequestOptions & { cursor?: string; limit?: number; unreadOnly?: boolean }) =>
      request<Schemas['InAppNotificationListResponseDto']>('GET', '/notifications', undefined, {
        ...options,
        query: { cursor: options?.cursor, limit: options?.limit, unreadOnly: options?.unreadOnly },
      }),

    /** One integer. This is what the bell polls, so it does not read a page of rows to draw a badge. */
    unreadCount: (options?: RequestOptions) =>
      request<Schemas['UnreadCountResponseDto']>('GET', '/notifications/unread-count', undefined, options),

    /**
     * Marking read is idempotent server-side and returns the unread count, so the
     * caller can settle its own badge from the response instead of refetching a
     * number it already has the new value of.
     */
    markRead: (id: string, options?: RequestOptions) =>
      request<{ id: string; readAt: string; unreadCount: number }>(
        'POST',
        `/notifications/${encodeURIComponent(id)}/read`,
        {},
        options,
      ),

    markAllRead: (options?: RequestOptions) =>
      request<{ updated: number; unreadCount: number }>('POST', '/notifications/read-all', {}, options),
  },

  health: (options?: RequestOptions) =>
    request<{ status: string; uptimeSeconds: number; checks: { database: string; cache: string } }>(
      'GET',
      '/health',
      undefined,
      options,
    ),
} as const;

export type Api = typeof api;
