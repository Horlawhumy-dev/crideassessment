import { ApiError } from './errors';

/**
 * Query keys, in one place.
 *
 * The previous app had `'use-partial'` as a query key — a typo, which meant the
 * dashboard's partial-render key and a hypothetical settings key could collide.
 * Query keys are a shared namespace and hand-typed strings are how they get
 * desynchronised, so every key is built here from a hierarchy.
 *
 * `ride` has no key, deliberately. §4.15: a ride is a live projection maintained
 * by the socket, and the query cache holds only the last server truth. One
 * writer, one source.
 */
export const queryKeys = {
  session: ['session'] as const,
  ride: {
    list: (filters: { cursor?: string; limit?: number; status?: string; driverId?: string }) =>
      ['rides', 'list', filters] as const,
    /**
     * `GET /rides/available` takes no radius and no coordinates.
     *
     * The old key accepted `{ lat, lng, radiusKm }`, which the route has never
     * honoured: an offer is a broadcast to every available driver, not a
     * proximity search. Keying on values the server ignores means two caches that
     * are semantically identical are treated as different lists, so an
     * `invalidateQueries` after an offer misses whichever key the screen is using.
     */
    available: (filters: { cursor?: string; limit?: number; status?: string } = {}) =>
      ['rides', 'available', filters] as const,
    active: ['rides', 'active'] as const,
    detail: (rideId: string) => ['rides', 'detail', rideId] as const,
  },
  driver: {
    availability: ['driver', 'availability'] as const,
    history: (cursor?: string) => ['driver', 'history', cursor ?? null] as const,
  },
  devices: ['devices'] as const,
  notifications: {
    /**
     * Separate from `unreadCount` below, and the split is deliberate. The bell is
     * mounted on every authenticated page and draws from one integer; the list is
     * fetched when the panel opens. Keying both off `notifications` and
     * invalidating the whole subtree to settle a badge would refetch a page of
     * rows nobody is looking at.
     *
     * `unreadOnly` is in the key because it is a different list, not a filter over
     * one cache entry — same reasoning as the `status` filter on rides.
     */
    list: (filters: { unreadOnly?: boolean; limit?: number } = {}) => ['notifications', 'list', filters] as const,
    unreadCount: ['notifications', 'unread-count'] as const,
  },
  health: ['health'] as const,
} as const;

/**
 * Retries are decided by the error, not by the request.
 *
 * Retrying a 409 is pointless — the answer will not change, and a ride that
 * another driver already accepted will still be accepted. Retrying a 5xx is the
 * whole point. A blanket `retry: 3` on every query is the usual shortcut and it
 * is why apps hammer a struggling API and still show the wrong thing.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;

  if (error instanceof ApiError) {
    if (error.isConflict) return false;
    if (error.isVersionConflict) return false;
    if (error.isValidation) return false;
    if (error.isUnauthenticated) return false;
    if (error.isForbidden) return false;
    if (error.isRateLimited) return false;
    if (error.isNotFound) return false;
    return error.isTransient;
  }

  // An unknown failure is assumed transient: a bug in a transform should not
  // turn into three silent requests, but a network blip should be survivable.
  return failureCount < 1;
}

export const RETRY_DELAYS = [400, 1200] as const;
