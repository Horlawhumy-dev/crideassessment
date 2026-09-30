'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Car, Radio, Wifi, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Dot } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query-keys';
import { useRideState } from '@/lib/rides/ride-provider';
import { ACTIVE_STATUS_FILTER } from '@/lib/ride-status';
import { syncAvailability } from '@/lib/realtime/socket';
import type { Ride, RideStatus } from '@/lib/types';
import { RideCard } from '../rides/ride-card';
import { useRideTransitions } from '../rides/use-ride-transitions';

/**
 * The driver's dashboard. Availability, the current trip, and the offer queue.
 *
 * The availability switch is the piece worth reading.
 *
 * §4.6 makes availability a *server* fact, not a preference: the gateway puts an
 * available driver into the `drivers:available` room, and only that room receives
 * `ride:offer`. So the switch cannot be local state that happens to look right —
 * if the client believed it was online while the server thought it was offline,
 * the driver would sit waiting for offers that were never sent, with no
 * explanation. It optimistically flips for responsiveness and then reconciles
 * against `PATCH /driver/availability`, and a failure rolls it back and says so.
 *
 * The old `DriverDashboard` toggled a React `useState` and told the server
 * nothing, so a driver had no way to know whether they were actually on the road.
 */
export function DriverHome({ driverId, displayName }: { driverId: string; displayName: string }) {
  const queryClient = useQueryClient();
  const { state, adoptRide, connection, displayLocation, simulating, startSimulation, stopSimulation } = useRideState();
  const transitions = useRideTransitions();

  const availability = useQuery({
    queryKey: queryKeys.driver.availability,
    queryFn: ({ signal }) => api.driver.availability({ signal }),
    staleTime: 0,
  });

  /**
   * The driver's current trip, from the server. §4.4: a driver who reloads the
   * page mid-trip must find the trip, not an empty dashboard. The filter is the
   * backend's own, and `driverId` scopes it to this driver.
   */
  const currentTrip = useQuery({
    queryKey: queryKeys.ride.list({ status: ACTIVE_STATUS_FILTER, limit: 1 }),
    queryFn: ({ signal }) => api.rides.listHistory({ status: ACTIVE_STATUS_FILTER, limit: 1, signal }),
    refetchInterval: 30_000,
  });

  const serverTrip = currentTrip.data?.items[0] ?? null;
  const activeRide: Ride | null = state.active ?? serverTrip;

  useEffect(() => {
    if (serverTrip && state.active?.id !== serverTrip.id) adoptRide(serverTrip);
  }, [serverTrip, state.active?.id, adoptRide]);

  const isOnline = availability.data?.isAvailable ?? false;

  /**
   * The offer queue. §4.7: an offer is a notification, not a payload — it has no
   * pickup, no distance and no fare. So the queue is the *available rides list*,
   * refetched when an offer arrives, and the socket's only job is to say "go and
   * look". The old app tried to render the offer's contents and showed an empty
   * pickup line as a result.
   *
   * `offerPulse` is a counter rather than a boolean because two offers inside one
   * render must invalidate twice; a boolean would collapse them and the second
   * rider's request would sit invisible until the next poll. The `ride.requested`
   * broadcast reaches every available driver at once, so "several at a time" is the
   * normal case, not an edge case.
   */
  const [offerPulse, setOfferPulse] = useState(0);
  useEffect(() => {
    const onOffer = () => setOfferPulse((n) => n + 1);
    window.addEventListener('cride:offer', onOffer);
    return () => window.removeEventListener('cride:offer', onOffer);
  }, []);

  const offers = useQuery({
    queryKey: queryKeys.ride.available({}),
    queryFn: ({ signal }) => api.rides.listAvailable({ signal, limit: 10 }),
    enabled: isOnline && !activeRide,
  });

  // The socket said there is something new; the payload cannot say what, so the
  // list is the only thing that can. Without this the query has no refetch trigger
  // at all and the queue is accurate only as of the last page load.
  useEffect(() => {
    if (offerPulse > 0) void queryClient.invalidateQueries({ queryKey: queryKeys.ride.available({}) });
  }, [offerPulse, queryClient]);

  /**
   * The announcement is driven by the *list*, not by the offer signal.
   *
   * `ride.requested` is broadcast to every driver who is online, so receiving it
   * proves only that a rider asked somewhere — not that this driver has anything
   * to accept. Announcing on the signal told a driver "a new ride request is
   * available" while the queue underneath it read "Nothing yet", which is worse
   * than silence: a driver who trusts it opens an empty list and stops believing
   * the next one. It fires with DRIVER_MATCHING_ENABLED=false, where nothing is
   * ever offered, and it fires when another driver took the ride first.
   *
   * So the count is the announcement: the toast happens when a refetched list is
   * *longer* than the one already on screen. `null` until the first response, and
   * the first response only sets the baseline — arriving on the page is not an
   * event, and the driver can see the list without being told to.
   */
  const offeredCount = offers.data?.items.length;
  const announcedCount = useRef<number | null>(null);
  useEffect(() => {
    if (offeredCount === undefined) return;
    const previous = announcedCount.current;
    announcedCount.current = offeredCount;
    if (previous === null || offeredCount <= previous) return;
    toast.info('A new ride request is available.', { description: 'Open the queue to accept it.' });
  }, [offeredCount]);

  const setAvailability = useMutation({
    mutationFn: (next: boolean) => api.driver.setAvailability(next),
    onMutate: async (next) => {
      // Optimistic, and reverted on failure. The switch must not appear to
      // succeed when the server still has the driver offline.
      await queryClient.cancelQueries({ queryKey: queryKeys.driver.availability });
      const previous = queryClient.getQueryData<{ driverId: string; isAvailable: boolean }>(queryKeys.driver.availability);
      queryClient.setQueryData(queryKeys.driver.availability, { driverId, isAvailable: next });
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.driver.availability, context.previous);
      toast.error(error instanceof ApiError ? error.displayMessage : 'Could not change your status.');
    },
    onSuccess: (result, next) => {
      queryClient.setQueryData(queryKeys.driver.availability, result);
      toast.success(next ? 'You are online. Offers will appear here.' : 'You are offline. No new offers.');
      // PATCH made the flag durable. It did not move this socket anywhere, and that
      // is the whole ballgame: `ride:offer` is broadcast to the `drivers:available`
      // room, and a driver is in that room only while their *socket* is in it. The
      // server reads the persisted flag on connect, which is why going online used
      // to appear to work on the next page load and not before — and why the only
      // thing that made requests visible was a reload.
      void syncAvailability();
    },
  });

  const firstName = displayName.split(/\s+/)[0] ?? displayName;

  /**
   * Cancelling the ride you are on. A driver asked to cancel was a driver told to
   * abandon a passenger with no way to tell the passenger, and §4.13 still refuses
   * the rider here: once a driver is committed, only the driver can end the trip.
   *
   * `activeRide.version` is the version this screen is rendering, which is what
   * lets the server reject a stale cancel instead of overwriting a state the
   * screen never saw.
   */
  const handleCancel = useCallback(async () => {
    // The button is only rendered when there is a ride, but the callback outlives
    // that check: a cancel can be in flight when the socket moves `activeRide` to
    // null, and cancelling a ride that is no longer on screen is a request built
    // from a stale version.
    if (!activeRide) return;

    const reason = window.prompt(
      'Why are you cancelling this ride? The rider will see this.',
      'Unable to complete the trip',
    );
    // `prompt` answers null when dismissed and '' when submitted empty. Both mean
    // the driver changed their mind, and neither should end somebody's trip.
    if (reason === null || reason.trim() === '') return;
    await transitions.cancel(activeRide, reason.trim());
  }, [activeRide, transitions]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex items-center gap-4 p-4">
          <div
            className={[
              'grid size-11 shrink-0 place-items-center rounded-2xl transition-colors',
              isOnline ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground',
            ].join(' ')}
          >
            <Car className="size-5" aria-hidden />
          </div>

          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {isOnline ? 'You are online' : 'You are offline'}
              {isOnline && <span className="sr-only">, receiving ride offers</span>}
            </p>
            <p className="text-muted-foreground truncate text-sm">
              {isOnline ? 'Waiting for a rider nearby.' : 'Go online to start receiving offers.'}
            </p>
          </div>

          <Switch
            checked={isOnline}
            disabled={availability.isPending || setAvailability.isPending}
            onCheckedChange={(next) => setAvailability.mutate(next)}
            aria-label="Available for rides"
          />
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 text-xs">
        <ConnectionLine state={connection} />
        {isOnline ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5">
            <Dot tone="success" pulse />
            Listening for offers near Osogbo
          </span>
        ) : (
          <span className="text-muted-foreground">Offers arrive only while you are online.</span>
        )}
      </div>

      {activeRide ? (
        <>
          <RideCard
            ride={activeRide}
            role="DRIVER"
            driverLocation={displayLocation}
            pending={transitions.pending}
            busy={transitions.busy}
            onTransition={(status: RideStatus) => void transitions.run(activeRide, status)}
            onCancel={() => void handleCancel()}
          />

          {/* §11. A driver on a laptop has no phone feeding fixes, so a live trip
              would be a car that never moves. This drives the real socket path —
              same throttle, same server-side jump check — instead of faking a
              position in the UI, so what is demonstrated is what ships. */}
          {activeRide.status === 'ACCEPTED' && (
            <button
              type="button"
              onClick={() => (simulating ? stopSimulation() : startSimulation(activeRide.id))}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 self-start text-xs underline underline-offset-4"
            >
              <Radio className="size-3.5" aria-hidden />
              {simulating ? 'Stop sending my position' : 'Simulate driving to the pickup'}
            </button>
          )}
        </>
      ) : (
        <OfferQueue
          offers={offers.data?.items ?? []}
          isLoading={offers.isPending && isOnline}
          isOnline={isOnline}
          firstName={firstName}
        />
      )}
    </div>
  );
}

function ConnectionLine({ state }: { state: ReturnType<typeof useRideState>['connection'] }) {
  if (state === 'connected') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5">
        <Wifi className="size-3.5" aria-hidden />
        Live
      </span>
    );
  }
  return (
    <span className="text-warning inline-flex items-center gap-1.5">
      <WifiOff className="size-3.5" aria-hidden />
      {state === 'offline' ? 'Connection lost' : 'Reconnecting'}
    </span>
  );
}

function OfferQueue({
  offers,
  isLoading,
  isOnline,
  firstName,
}: {
  offers: Ride[];
  isLoading: boolean;
  isOnline: boolean;
  firstName: string;
}) {
  if (!isOnline) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No offers</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          Go online and C-Ride will send you ride requests as riders nearby ask for trips.
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy>
        <div className="bg-muted h-24 animate-pulse rounded-2xl" />
        <div className="bg-muted h-24 animate-pulse rounded-2xl" />
      </div>
    );
  }

  if (offers.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Waiting for a request, {firstName}</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          Nothing yet. This list updates by itself as riders nearby request trips.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-muted-foreground text-xs">
        {offers.length} ride{offers.length === 1 ? '' : 's'} available. First come, first served.
      </p>
      {offers.map((ride) => (
        <OfferRow key={ride.id} ride={ride} />
      ))}
    </div>
  );
}

function OfferRow({ ride }: { ride: Ride }) {
  const { state } = useRideState();
  const transitions = useRideTransitions();
  const busy = state.pending === 'ACCEPTED' || transitions.busy;

  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{ride.pickupAddress ?? 'Pickup nearby'}</p>
          <p className="text-muted-foreground truncate text-xs">to {ride.dropoffAddress ?? 'a destination in Osogbo'}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          // `run` adopts the server's response, which is the accepted ride with a
          // new version. Adopting `ride` here as well would overwrite that with
          // the pre-accept copy — version 1, status REQUESTED — and put the
          // driver's dashboard visibly back where it started.
          onClick={() => void transitions.run(ride, 'ACCEPTED')}
          className="bg-primary text-primary-foreground hover:bg-primary/85 inline-flex h-9 shrink-0 items-center rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-50"
        >
          {busy ? 'Accepting…' : 'Accept'}
        </button>
      </CardContent>
    </Card>
  );
}
