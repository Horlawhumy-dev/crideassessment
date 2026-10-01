'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useRideState } from '@/lib/rides/ride-provider';
import type { Ride, RideStatus } from '@/lib/types';

/**
 * Every status transition in the app, in one hook.
 *
 * Three rules, all consequences of §4.5.2c and §4.13:
 *
 * 1. **The version is always sent.** The caller never gets a choice. A transition
 *    without a version is last-writer-wins, which is how two drivers both end up
 *    believing they started the same trip — and the server's `version` field
 *    exists precisely to make that impossible.
 *
 * 2. **Optimistic, but only in the button.** The control responds immediately,
 *    because a driver in traffic should not wait on a round trip to learn whether
 *    a tap registered. The *ride* is not painted optimistically: the server's
 *    answer always replaces it, so there is nothing to roll back. The previous
 *    dashboard set `status` in local state, then overwrote it from the refetch,
 *    which is the flicker nobody could reproduce.
 *
 * 3. **A 409 is a resync, not an error.** `RIDE_VERSION_CONFLICT`,
 *    `RIDE_ALREADY_ACCEPTED` and `INVALID_TRANSITION` all mean the server's state
 *    moved. The response is refetch-and-redraw with a plain sentence. The old app
 *    showed the raw code and left the button disabled.
 *
 * Note this is not a `useMutation`. There is one ride in flight at a time and the
 * interesting state lives in the ride reducer, so a cache entry per transition
 * would be a second source of truth for the same fact.
 */
export function useRideTransitions() {
  const { state, adoptRide } = useRideState();
  const [busy, setBusy] = useState(false);

  /**
   * The in-flight guard is a ref, not the `busy` state.
   *
   * `busy` is one render behind by construction: `setBusy(true)` does not
   * re-render, so a second click inside the same tick still reads `busy === false`
   * from the captured closure and both requests go out. On one offer row that is
   * two `PATCH /rides/:id/accept` calls; since this hook is mounted per row on the
   * driver screen, two different rows can double-submit independently. The server
   * rejects the loser with a 409, so nothing corrupts — but the user sees a toast
   * about a conflict they caused, which is worse than the debounce it looks like.
   *
   * A ref is checked and set synchronously, so the second call in the same tick
   * sees the first. `busy` state is kept for rendering only.
   */
  const inFlight = useRef(false);

  const execute = useCallback(
    async (ride: Ride, attempt: () => Promise<Ride>): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);

      try {
        adoptRide(await attempt());
        return true;
      } catch (error) {
        handleFailure(error, ride.id, adoptRide);
        return false;
      } finally {
        // `finally`, not the success path. A failure that leaves the guard set is
        // the button that says "Working…" forever, which is exactly the bug in
        // the old DriverDashboard.
        inFlight.current = false;
        setBusy(false);
      }
    },
    [adoptRide],
  );

  const run = useCallback(
    (ride: Ride, status: RideStatus) =>
      execute(ride, () =>
        status === 'ACCEPTED'
          ? api.rides.accept(ride.id)
          : api.rides.transition(ride.id, { to: status, version: ride.version }),
      ),
    [execute],
  );

  /**
   * Cancellation is a transition like any other, so it goes through the same
   * conflict handling rather than through a bespoke request that would have to
   * learn it a second time. It is a separate function only because it carries a
   * `reason`: the driver is the only party who knows *why* — broken down, rider
   * absent, wrong address — and that is the information support asks for first.
   *
   * The version is still mandatory. A driver cancelling a trip while a passenger
   * screen is also cancelling it should produce one cancellation, not a 500 from
   * two writers racing the same row.
   */
  const cancel = useCallback(
    (ride: Ride, reason?: string) => execute(ride, () => api.rides.cancel(ride.id, ride.version, reason)),
    [execute],
  );

  return { run, cancel, busy, pending: state.pending };
}

async function handleFailure(error: unknown, rideId: string, adopt: (ride: Ride) => void): Promise<void> {
  if (!(error instanceof ApiError)) {
    toast.error('Something went wrong. Please try again.');
    return;
  }

  // Every one of these means the same thing to a user: the ride moved on without
  // them. So every one of them is answered the same way — go and look.
  if (error.isConflict || error.code === 'INVALID_TRANSITION' || error.code === 'WRONG_ACTOR_FOR_TRANSITION') {
    toast.info('That ride has already moved on.', { description: 'Showing the current status.' });
    await refetchRide(rideId, adopt);
    return;
  }

  if (error.isForbidden) {
    toast.error('That ride is not yours to change.');
    await refetchRide(rideId, adopt);
    return;
  }

  toast.error(error.displayMessage);
  if (error.debugHint) {
    // Not in the toast body: too small to read, and it is for a bug report.
    console.warn('[cride]', error.code, error.debugHint);
  }
}

async function refetchRide(rideId: string, adopt: (ride: Ride) => void): Promise<void> {
  try {
    const detail = await api.rides.get(rideId);
    // The detail response is a superset of the ride, so it adopts directly. The
    // cast is because `RideDetailResponseDto` is the same shape plus `events`.
    adopt(detail as unknown as Ride);
  } catch {
    // Nothing to do: the next socket frame, or the next manual refresh, will land.
  }
}
