'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query-keys';
import { MapView } from '@/lib/map';
import { currentPosition } from '@/lib/realtime/socket';
import { useRideState } from '@/lib/rides/ride-provider';
import type { GeoPoint, Ride, RideStatus } from '@/lib/types';
import { RequestRidePanel } from './request-ride-panel';
import { RideCard } from './ride-card';
import { useRideTransitions } from './use-ride-transitions';

/**
 * The rider's home. Two states, not three.
 *
 * The old dashboard had a third — `loading ? skeleton : error ? red text :
 * empty` — where "no trips yet" and "the request failed" rendered identically,
 * because `lib/api.ts` returned `any` and the `catch` set the same flag an empty
 * list did. Here failure is its own component with its own retry, so an empty
 * state is never shown for a request that failed.
 *
 * The active ride is recovered from the API on mount, not remembered locally. A
 * hard refresh, a new tab, or a phone waking after an hour all land on the same
 * answer: what the server says is happening now.
 */
export function RiderHome() {
  const { state, adoptRide, driverLocation, displayLocation, driverPath } = useRideState();
  const transitions = useRideTransitions();
  const [serverError, setServerError] = useState<ApiError | null>(null);
  const [center, setCenter] = useState<GeoPoint | null>(null);

  /**
   * The backend's own comma-separated status filter, not a browser-side one.
   *
   * The old client fetched a page and then filtered it, which meant an active
   * ride on page two was invisible, the rider could request a second one, and
   * they got RIDER_ALREADY_HAS_ACTIVE_RIDE for a reason nothing on screen
   * explained.
   */
  const ACTIVE = 'REQUESTED,ACCEPTED,IN_PROGRESS';

  const active = useQuery({
    queryKey: queryKeys.ride.list({ status: ACTIVE, limit: 1 }),
    queryFn: ({ signal }) => api.rides.listHistory({ status: ACTIVE, limit: 1, signal }),
    refetchInterval: 30_000,
  });

  const serverRide = active.data?.items[0] ?? null;
  const activeRide: Ride | null = state.active ?? serverRide;

  // The socket is the writer while a ride is live; the server is the writer
  // before one exists. Adopting only when the ids disagree keeps the two from
  // overwriting each other on every refetch.
  useEffect(() => {
    if (serverRide && state.active?.id !== serverRide.id) adoptRide(serverRide);
  }, [serverRide, state.active?.id, adoptRide]);

  const handleRequest = useCallback(
    async (input: { pickup: GeoPoint; dropoff: GeoPoint; pickupAddress?: string; dropoffAddress?: string }) => {
      setServerError(null);
      try {
        adoptRide(await api.rides.request(input));
        await active.refetch();
      } catch (error) {
        if (error instanceof ApiError) setServerError(error);
        else throw error;
      }
    },
    [adoptRide, active],
  );

  const handleCancel = useCallback(async () => {
    if (!activeRide) return;
    setServerError(null);
    try {
      // §4.13: a rider may cancel only while REQUESTED. `allowedActions` hides
      // the button otherwise, and the version goes with it so a cancel cannot
      // land against a ride accepted a moment earlier.
      adoptRide(await api.rides.cancel(activeRide.id, activeRide.version));
      await active.refetch();
    } catch (error) {
      if (error instanceof ApiError) setServerError(error);
      else throw error;
    }
  }, [activeRide, adoptRide, active]);

  const handleTransition = useCallback(
    (status: RideStatus) => {
      if (activeRide) void transitions.run(activeRide, status);
    },
    [activeRide, transitions],
  );

  return (
    <div className="flex flex-col gap-4">
      <section className="relative">
        <MapView
          className="h-64 w-full sm:h-80"
          pickup={activeRide?.pickup ?? center}
          dropoff={activeRide?.dropoff ?? null}
          driverLocation={displayLocation}
          // The road the driver actually drove, so the line on the map is the one
          // the car is on rather than a straight line between the two pins.
          route={driverPath}
          status={activeRide?.status ?? null}
          fare={activeRide?.fare ?? null}
        />
        {!activeRide && (
          <LocateMeButton
            onLocated={setCenter}
            className="absolute top-3 right-3 z-10"
          />
        )}
      </section>

      {activeRide ? (
        <RideCard
          ride={activeRide}
          role="RIDER"
          driverLocation={driverLocation}
          pending={transitions.pending}
          busy={transitions.busy}
          onTransition={handleTransition}
          onCancel={() => void handleCancel()}
        />
      ) : active.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-44 w-full rounded-2xl" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : active.isError ? (
        <ErrorState error={active.error} onRetry={() => void active.refetch()} />
      ) : (
        <RequestRidePanel
          submitting={transitions.busy}
          serverError={serverError}
          onSubmit={(input) => void handleRequest(input)}
        />
      )}
    </div>
  );
}

/**
 * Geolocation that cannot fail the screen.
 *
 * `currentPosition` resolves `null` when permission is denied, because §5.11
 * requires the app to stay usable without a fix. A thrown geolocation error on
 * the page whose whole job is a map is a blank screen for someone who simply
 * said no — which is a far worse outcome than a map centred on Osogbo.
 */
function LocateMeButton({ onLocated, className }: { onLocated: (point: GeoPoint) => void; className?: string }) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className={`bg-card/95 hover:text-foreground text-muted-foreground inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium shadow-sm backdrop-blur transition-colors ${className ?? ''}`}
      onClick={async () => {
        setBusy(true);
        const position = await currentPosition();
        setBusy(false);
        if (position) onLocated({ lat: position.coords.latitude, lng: position.coords.longitude });
      }}
      disabled={busy}
    >
      {busy ? 'Locating…' : 'Use my location'}
    </button>
  );
}
