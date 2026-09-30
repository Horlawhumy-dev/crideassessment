'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { api } from '../api/client';
import { ApiError } from '../api/errors';
import { queryKeys } from '../api/query-keys';
import { isTerminal } from '../ride-status';
import { pointAlongRoute, routePolyline } from '../places';
import {
  acquireSocket,
  currentPosition,
  INBOUND,
  INTERNAL_FRAME,
  joinRide,
  leaveRide,
  OUTBOUND,
  releaseSocket,
  shareLocation,
  syncAvailability,
  syncRide,
  type RideSnapshotAck,
} from '../realtime/socket';
import type { DriverLocation, Ride, RideSnapshot, UserRole } from '../types';
import {
  applyFrame,
  clearActiveRide,
  initialRideState,
  markPending,
  maxSeq,
  reconcile,
  type IncomingFrame,
  type RideState,
  type StatusFrame,
} from './machine';

/**
 * The seam between the socket and the client, and the only place they meet.
 *
 * `machine.ts` decides what a frame may change. This provider does the I/O:
 * connects, routes frames in, and performs the refetch a status frame requires.
 *
 * The previous app applied frames straight into component state through a switch
 * statement, so `ride:status_changed` set a status derived from a payload that
 * contained no status, and a background refetch clobbered the socket's update a
 * second later. That flicker — the one nobody could reproduce — was two writers
 * to one field. Here a frame that cannot be applied authoritatively raises
 * `needsRefetch`, and the answer is a server read.
 */

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

interface RideContextValue {
  state: RideState;
  connection: ConnectionState;
  driverLocation: RideState['driverLocation'];
  error: string | null;
  clearError: () => void;
  simulating: boolean;
  startSimulation: (rideId: string) => void;
  stopSimulation: () => void;
  adoptRide: (ride: Ride) => void;
  dismissRide: () => void;
  /** Effective position: the socket's fix, or the simulated one while simulating. */
  displayLocation: RideState['driverLocation'];
  /**
   * Every position the driver has reported on this ride, oldest first.
   *
   * Server-confirmed only — it is the `ride:driver_location_update` frames the
   * machine applied, not the simulator's optimistic local fix. That is deliberate:
   * the path a rider is shown must be the path the server accepted, so the line and
   * the marker always agree about where the car is.
   */
  driverPath: RideState['driverPath'];
}

const RideContext = createContext<RideContextValue | null>(null);

/* ---- Reducer ---------------------------------------------------------------
 * Actions are named after their source, which is what keeps the socket, a REST
 * refetch and a user intent from all writing the same field without a rule.
 * ------------------------------------------------------------------------- */

type Action =
  | { type: 'frame'; frame: IncomingFrame }
  | { type: 'server'; snapshot: RideSnapshot | Ride }
  | { type: 'pending'; status: RideState['pending'] }
  | { type: 'clear' }
  | { type: 'error'; message: string | null };

function reducer(state: RideState, action: Action): RideState {
  switch (action.type) {
    case 'frame': {
      const result = applyFrame(state, action.frame);
      return result.state;
    }
    case 'server':
      return reconcile(state, action.snapshot);
    case 'pending':
      return action.status ? markPending(state, action.status) : { ...state, pending: null };
    case 'clear':
      return clearActiveRide(state);
    case 'error':
      return { ...state, pending: null };
    default:
      return state;
  }
}

export function RideProvider({ role, userId, children }: { role: UserRole; userId: string; children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialRideState);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  /** The ride the socket is currently subscribed to. Ref, not state: re-subscribing is an effect. */
  const subscribedRideId = useRef<string | null>(null);
  /** Suppresses a refetch storm when many frames arrive at once. */
  const refetchInFlight = useRef(false);

  const refetchActiveRide = useCallback(async () => {
    if (refetchInFlight.current) return;
    refetchInFlight.current = true;
    try {
      // `GET /rides/{id}` is the authority. A frame said something changed; this
      // says what it changed to.
      const detail = await api.rides.get(subscribedRideId.current ?? '');
      if (detail.id) {
        const snapshot: RideSnapshot = {
          ride: detail,
          events: detail.events ?? [],
          // `maxSeq`, not `events[0].seq`. The API orders events ascending, so
          // `events[0]` is `ride.requested` and using it pinned lastSeq to 1 after
          // every refetch — which then made every real frame look like a replay
          // and quietly discarded it. The trail was frozen at "requested" while
          // the ride was three transitions in.
          lastSeq: maxSeq(detail.events),
        };
        dispatch({ type: 'server', snapshot });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.ride.list({}) });
    } catch (cause) {
      if (cause instanceof ApiError && cause.isNotFound) {
        // The ride the socket is telling us about is gone or no longer visible.
        // Stop following it rather than polling a 404 forever.
        dispatch({ type: 'clear' });
        if (subscribedRideId.current) leaveRide(subscribedRideId.current);
        subscribedRideId.current = null;
        return;
      }
      setError(cause instanceof ApiError ? cause.displayMessage : 'Could not reach C-Ride.');
    } finally {
      refetchInFlight.current = false;
    }
  }, [queryClient]);

  /* ---- Connection lifecycle ---------------------------------------------- */

  useEffect(() => {
    const active = acquireSocket();

    const onConnect = () => {
      setConnection('connected');
      // No `joinSession`. There is no such handler, and there is no "my rides"
      // channel to join: `handleConnection` puts a driver in their personal room
      // server-side, and a rider's rides arrive because the outbox publishes to
      // each ride's room. The only thing a client joins is one specific ride, and
      // that is an authorization decision the gateway makes deliberately.
      //
      // What a reconnect does need is a resync: rooms live on the server's
      // connection object, so a new socket is in none of them, and the frames
      // that happened while it was down are gone. `ride:sync` returns the ride,
      // everything missed, and the authoritative `lastSeq`.
      requestSync();
    };

    const onDisconnect = () => setConnection('reconnecting');
    const onReconnectAttempt = () => setConnection('reconnecting');
    const onConnectError = () => setConnection('offline');

    active.on('connect', onConnect);
    active.on('disconnect', onDisconnect);
    active.io.on('reconnect_attempt', onReconnectAttempt);
    active.io.on('error', onConnectError);

    return () => {
      active.off('connect', onConnect);
      active.off('disconnect', onDisconnect);
      active.io.off('reconnect_attempt', onReconnectAttempt);
      active.io.off('error', onConnectError);
      releaseSocket();
    };
  }, [role, userId, refetchActiveRide]);

  /* ---- Frame routing ------------------------------------------------------ */

  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * §4.8.3. Ask the server for the truth rather than assume nothing was missed.
   *
   * There is no `ride:resync` push to wait for — resyncing is a request, and the
   * snapshot arrives as the ack. So a detected gap issues the request here, and
   * the ack is fed back in as an internal `sync:applied` frame, which is the only
   * frame the machine will let replace the whole ride.
   *
   * The REST refetch is the fallback for a request that never gets an ack, so a
   * dropped message degrades to a slower correct answer rather than a stuck
   * "reconnecting" chip.
   */
  const requestSync = useCallback(async () => {
    const rideId = stateRef.current.active?.id ?? subscribedRideId.current;
    if (!rideId) return;

    const ack: RideSnapshotAck | null = await syncRide(rideId, stateRef.current.lastSeq);
    if (ack?.ride) {
      dispatch({ type: 'frame', frame: { type: INTERNAL_FRAME.syncApplied, ...ack } });
      return;
    }
    void refetchActiveRide();
  }, [refetchActiveRide]);

  useEffect(() => {
    const active = acquireSocket();

    /**
     * Turn a wire payload into a frame.
     *
     * The outbox payload is flat, and this is the boundary where that fact is
     * asserted rather than assumed. `ride:status_changed` arrives as
     * `{ eventId, seq, rideId, ts, correlationId, status }` — the previous code
     * read `payload.event.seq`, which was always `undefined`, so seq-based replay
     * protection and gap detection were both inert.
     */
    const handle = (type: string, payload: Omit<IncomingFrame, 'type'>, notifiable = false) => {
      const frame: IncomingFrame = { type, ...payload };
      const current = stateRef.current;
      const result = applyFrame(current, frame);

      if (result.state !== current) dispatch({ type: 'frame', frame });

      if (result.isOffer) {
        // §4.7: the offer payload is `{ seq, rideId, fareMinor, currency }` — no
        // pickup, no distance, no fare object. It is a notification to go and
        // look, not a card to render. Invalidating the available list is the whole
        // handling, and it is correct: a list fetched before the offer existed
        // cannot contain it.
        void queryClient.invalidateQueries({ queryKey: ['rides', 'available'] });
        window.dispatchEvent(new CustomEvent('cride:offer', { detail: { rideId: payload.rideId } }));
      }

      // A gap asks the socket first, because the socket is both cheaper and the
      // only path that repairs `lastSeq`. Only a silent request falls back to REST.
      if (result.needsSync) void requestSync();
      else if (result.needsRefetch) void refetchActiveRide();

      // Only the frames that can write an inbox row, and only for the user they
      // were addressed to. Location frames are excluded on purpose: a driver
      // posts one every LOCATION_MIN_INTERVAL_MS, and invalidating on those would
      // refetch the badge three times a second, forever, for a count that cannot
      // have changed.
      if (notifiable) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount });
      }
    };

    // Registered by the names the gateway and RealtimeHandler actually use.
    active.on(OUTBOUND.locationUpdate, (p: DriverLocation) =>
      handle(OUTBOUND.locationUpdate, { rideId: p.rideId, location: p }),
    );
    active.on(OUTBOUND.statusChanged, (p: StatusFrame) => handle(OUTBOUND.statusChanged, p, true));
    active.on(OUTBOUND.assigned, (p: StatusFrame) => handle(OUTBOUND.assigned, p, true));
    active.on(OUTBOUND.released, (p: StatusFrame) => handle(OUTBOUND.released, p, true));
    active.on(OUTBOUND.offer, (p: StatusFrame) => handle(OUTBOUND.offer, p));
    active.on(OUTBOUND.error, (p: { message?: string }) => {
      setError(p?.message ?? 'The connection reported a problem.');
    });

    return () => {
      active.off(OUTBOUND.locationUpdate);
      active.off(OUTBOUND.statusChanged);
      active.off(OUTBOUND.assigned);
      active.off(OUTBOUND.released);
      active.off(OUTBOUND.offer);
      active.off(OUTBOUND.error);
    };
  }, [queryClient, refetchActiveRide, requestSync]);

  /* ---- Keep the active ride subscribed ------------------------------------ */

  const activeRideId = state.active?.id ?? null;

  useEffect(() => {
    const previous = subscribedRideId.current;
    if (previous === activeRideId) return;

    if (previous) leaveRide(previous);
    subscribedRideId.current = activeRideId;

    if (activeRideId) {
      // Resuming from lastSeq is what makes a reconnect cheap instead of a full
      // replay, and what makes a gap detectable. The ack is a full snapshot — the
      // ride plus everything after lastSeq — so it is applied as one, rather than
      // guessed at from whatever the local state happened to hold.
      void joinRide(activeRideId, stateRef.current.lastSeq).then((ack) => {
        if (ack?.ride) {
          dispatch({ type: 'frame', frame: { type: INTERNAL_FRAME.syncApplied, ...ack } });
        } else {
          void refetchActiveRide();
        }
      });
    }

    return () => {
      if (previous) leaveRide(previous);
    };
  }, [activeRideId, refetchActiveRide]);

  /* ---- Driver location simulation ----------------------------------------
   * §11. A driver on a laptop has no phone sending fixes, so a live demo would
   * have a car that never moves. This drives the *real* socket path — same
   * throttle, same server-side jump check — rather than faking a position in the
   * UI, so the thing being demonstrated is the thing that ships.
   * ---------------------------------------------------------------------- */

  const [simulating, setSimulating] = useState(false);
  const [simulated, setSimulated] = useState<NonNullable<RideState['driverLocation']> | null>(null);
  const simulationTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef(0);

  const stopSimulation = useCallback(() => {
    if (simulationTimer.current) clearInterval(simulationTimer.current);
    simulationTimer.current = null;
    setSimulating(false);
    progressRef.current = 0;
  }, []);

  const startSimulation = useCallback(
    (rideId: string) => {
      const ride = stateRef.current.active;
      if (!ride || ride.id !== rideId || isTerminal(ride.status)) return;

      const route = routePolyline(ride.pickup, ride.dropoff, 40);
      progressRef.current = 0;
      setSimulated(null);
      setSimulating(true);

      // 700 ms, faster than LOCATION_THROTTLE_MS, so the throttle is what
      // actually governs the rate — the same guard a real client meets.
      simulationTimer.current = setInterval(() => {
        progressRef.current = Math.min(1, progressRef.current + 0.012);
        const step = pointAlongRoute(route, progressRef.current);
        if (!step) return;

        const fix = {
          rideId,
          driverId: ride.driverId ?? 'simulated',
          lat: step.point.lat,
          lng: step.point.lng,
          heading: step.heading,
          speedKph: 28,
          accuracyM: 8,
          recordedAt: new Date().toISOString(),
        };

        setSimulated(fix);
        shareLocation({
          rideId: fix.rideId,
          lat: fix.lat,
          lng: fix.lng,
          heading: fix.heading,
          speedKph: fix.speedKph,
          accuracyM: fix.accuracyM,
        });

        if (progressRef.current >= 1) stopSimulation();
      }, 700);
    },
    [stopSimulation],
  );

  useEffect(() => () => stopSimulation(), [stopSimulation]);

  /* ---- Actions ------------------------------------------------------------ */

  const adoptRide = useCallback((ride: Ride) => {
    dispatch({ type: 'server', snapshot: ride });
  }, []);

  const dismissRide = useCallback(() => {
    const id = subscribedRideId.current;
    if (id) leaveRide(id);
    subscribedRideId.current = null;
    dispatch({ type: 'clear' });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<RideContextValue>(
    () => ({
      state,
      connection,
      driverLocation: state.driverLocation,
      displayLocation: simulated ?? state.driverLocation,
      driverPath: state.driverPath,
      error,
      clearError,
      simulating,
      startSimulation,
      stopSimulation,
      adoptRide,
      dismissRide,
    }),
    [state, connection, error, clearError, simulating, startSimulation, stopSimulation, adoptRide, dismissRide, simulated],
  );

  return <RideContext.Provider value={value}>{children}</RideContext.Provider>;
}

export function useRideState(): RideContextValue {
  const value = useContext(RideContext);
  if (!value) {
    throw new Error('useRideState must be used inside <RideProvider>. Check the route group layout.');
  }
  return value;
}

export { currentPosition };
