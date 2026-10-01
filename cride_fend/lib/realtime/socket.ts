'use client';

import { io, type Socket } from 'socket.io-client';

import type { DriverLocation, Ride, RideEventLike } from '../types';

/**
 * The realtime contract, in one table.
 *
 * This file previously guessed six event names. Five were wrong, and the symptom
 * was silence: a socket that connects, subscribes to events nobody publishes, and
 * therefore never updates. A wrong event name fails *quietly*, which is the most
 * expensive kind of wrong.
 *
 * The names below are read off the gateway's `@SubscribeMessage` decorators and
 * its emit sites, not off the product document:
 *
 *   inbound   `ride:join` / `ride:leave` / `ride:sync` / `ride:transition`
 *             `driver:availability` / `ride:driver_location`
 *   outbound  `ride:driver_location_update`, plus the domain event names the
 *             outbox relay publishes (`ride:offer`, `ride:accepted`, …)
 *
 * Two things that are *not* here, because they do not exist:
 *
 *   `rider:join` and `driver:join` do not exist. A driver's personal channel is
 *   joined server-side in `handleConnection`; a rider's rides arrive because the
 *   outbox publishes to the ride's audience. A client cannot subscribe to
 *   "my rides" — it subscribes to a specific ride id, which is an authorization
 *   decision the server makes deliberately.
 *
 *   There is no `ride:subscribe`/`ride:unsubscribe` pair. They are `ride:join`
 *   and `ride:leave`.
 *
 * The connection is cross-origin and cannot go through the BFF, so it carries the
 * `cride.sid` cookie with `withCredentials`. That is the one place the two origins
 * genuinely interact.
 */

export const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Namespace, not path. The gateway is mounted at `/rides`, so the URL is `…/rides`. */
export const NAMESPACE = '/rides';

export const INBOUND = {
  joinRide: 'ride:join',
  leaveRide: 'ride:leave',
  syncRide: 'ride:sync',
  transition: 'ride:transition',
  setAvailability: 'driver:availability',
  sendLocation: 'ride:driver_location',
} as const;

/**
 * Outbound, and these are the five that actually exist.
 *
 * Read off `RealtimeHandler`, which translates each outbox row into exactly one
 * bus message per audience. Note what is absent: there is no `ride:accepted` and
 * no `ride:ride_requested`. The outbox *rows* are named `ride.accepted` and
 * `ride.requested` — dotted, no colon — and confusing the row name with the
 * socket name is how a client ends up listening for an event that is never
 * emitted and therefore silently never updates.
 *
 *   ride:status_changed   every committed transition, to the ride room
 *   ride:assigned         after an accept, to the ride room (carries `driverId`)
 *   ride:offer            new request, to the available-drivers room
 *   ride:released         a cancellation, to the driver who held the ride
 *   ride:driver_location_update   a position, to the ride room
 */
export const OUTBOUND = {
  statusChanged: 'ride:status_changed',
  assigned: 'ride:assigned',
  offer: 'ride:offer',
  released: 'ride:released',
  locationUpdate: 'ride:driver_location_update',
  error: 'error',
} as const;

/**
 * There is no `ride:resync` push.
 *
 * The product document calls the resync `ride:resync`, and the gateway has no
 * such emit. Resyncing is a *request*: `ride:sync` in, and the snapshot comes
 * back as that call's ack. A client that waits to be pushed a resync waits
 * forever, so the gap path below issues the request itself and feeds the ack
 * through a client-internal frame name.
 */
export const INTERNAL_FRAME = { syncApplied: 'sync:applied' } as const;

/** What `ride:join` and `ride:sync` return: server truth, not a delta. */
export interface RideSnapshotAck {
  ride: Ride;
  events: RideEventLike[];
  lastSeq: number;
}

export interface TransitionAck {
  ok: boolean;
  version: number;
  status: string;
}

/**
 * §4.9 guard 4: the server rejects a second position inside
 * `LOCATION_MIN_INTERVAL_MS`. Matching it here means a client that respects the
 * limit never sees a NACK, and a client that is ahead of the limit learns
 * immediately rather than silently.
 */
export const LOCATION_THROTTLE_MS = 1000;

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(`${API_ORIGIN}${NAMESPACE}`, {
      path: '/socket.io',
      // The handshake is authenticated by the httpOnly `cride.sid` cookie, and
      // there is no token in JS to send instead, so this is load-bearing.
      withCredentials: true,
      // No `transports` option, deliberately.
      //
      // This file used to say `transports: ['websocket', 'polling']`, which reads
      // like "prefer WebSocket" and is in fact a *pin*: listing a transport pins
      // the client to it. Against this API that produced the worst failure mode
      // available — the connection succeeded, so every UI indicator read "live",
      // and not one `@SubscribeMessage` handler ever ran. No ack ever came back
      // and no frame was ever delivered, so the app moved only when a REST
      // refetch happened to land.
      //
      // Verified directly against the running server, same cookie, same ride:
      //   ['websocket','polling'] -> silent, no ack, ever
      //   ['polling','websocket'] -> acks
      //   omitted (default)       -> acks
      //
      // The default starts on polling and upgrades, which costs one extra
      // round-trip on the handshake and is the only configuration whose message
      // handling actually works here.
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    });
  }
  return socket;
}

/**
 * Reference counting, so the connection outlives a route change but not the session.
 *
 * The provider mounts in the layout above the role routes, so in practice it is
 * mounted once — but "once" is a property of where it happens to be mounted today,
 * not of this module, and a refcount makes the lifetime explicit instead of assumed.
 *
 * Why not disconnect on the last release: the app router remounts route groups on
 * navigation, so tearing the socket down there costs a fresh handshake and a window
 * of dropped frames on every page change. Why not leave it open forever: a signed-out
 * user kept a live authenticated socket, and the next session to sign in on that tab
 * reused it — rooms and listeners belonging to the previous identity.
 *
 * The idle timeout is the compromise, and it is what makes "long-lived" safe: keep
 * the socket warm across navigations, but release it once nothing has needed it for
 * a while. A user who signs out and back in pays one handshake; a user clicking
 * around the app pays none.
 */
let consumers = 0;
let idleTimer: ReturnType<typeof setTimeout> | null | undefined;

const IDLE_DISCONNECT_MS = 30_000;

function cancelIdle(): void {
  if (idleTimer === null) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

export function acquireSocket(): Socket {
  consumers += 1;
  cancelIdle();
  return getSocket();
}

/**
 * Drop one consumer. The socket closes only when the last one leaves *and* the idle
 * window expires, so a route change never costs a handshake.
 */
export function releaseSocket(): void {
  consumers = Math.max(0, consumers - 1);
  if (consumers > 0 || idleTimer !== null) return;

  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (consumers === 0) disconnectSocket();
  }, IDLE_DISCONNECT_MS);
}

/**
 * Immediate close. For sign-out and session loss, where keeping a socket
 * authenticated as somebody who is no longer signed in is not acceptable.
 */
export function disconnectSocket(): void {
  cancelIdle();
  consumers = 0;
  socket?.disconnect();
  socket = null;
}

/**
 * Join a ride room, resuming from the last seq applied.
 *
 * The ack is a *snapshot*, not a delta: the ride as the server sees it plus every
 * event after `lastSeq`. That is what makes a reconnect cheap and what makes a
 * missed frame detectable — the client can compare its own `lastSeq` with the
 * one returned and know whether it is behind.
 */
export function joinRide(rideId: string, lastSeq = 0): Promise<RideSnapshotAck | null> {
  return withAck<RideSnapshotAck>(INBOUND.joinRide, { rideId, lastSeq });
}

export function leaveRide(rideId: string): void {
  getSocket().emit(INBOUND.leaveRide, { rideId });
}

/** The resync. Same payload as join, but without re-deciding the room. */
export function syncRide(rideId: string, lastSeq: number): Promise<RideSnapshotAck | null> {
  return withAck<RideSnapshotAck>(INBOUND.syncRide, { rideId, lastSeq });
}

/**
 * A state change over the socket rather than over REST.
 *
 * The gateway calls the same use case, so the state machine, the ownership rules,
 * the version check and the event log all apply identically. This is the lower
 * latency path and the one the architecture intends for a driver's Start and
 * Complete buttons.
 */
export function transitionRide(
  rideId: string,
  to: string,
  version: number,
  reason?: string,
): Promise<TransitionAck | null> {
  return withAck<TransitionAck>(INBOUND.transition, { rideId, to, version, ...(reason ? { reason } : {}) });
}

/**
 * §4.9. The REST route is what makes availability durable; this message is what
 * makes it take effect now. The handler re-reads the persisted flag rather than
 * trusting the payload, so the room and the database cannot disagree.
 */
export function syncAvailability(): Promise<{ ok: boolean; isAvailable: boolean } | null> {
  return withAck<{ ok: boolean; isAvailable: boolean }>(INBOUND.setAvailability, {});
}

export interface LocationAck {
  ok: boolean;
  code?: string;
}

/**
 * §4.9. Fire-and-forget, and the reason is specific: a rejected frame is dropped
 * rather than queued. A queue would replay stale positions on reconnect, drawing
 * the driver backwards down the map. The next position supersedes this one.
 */
export function shareLocation(location: {
  rideId: string;
  lat: number;
  lng: number;
  heading: number | null;
  speedKph: number | null;
  accuracyM: number | null;
}): void {
  getSocket().emit(INBOUND.sendLocation, location);
}

/** The ack for the last location frame, for tests and diagnostics. */
export function shareLocationAcked(location: Parameters<typeof shareLocation>[0]): Promise<LocationAck | null> {
  return withAck<LocationAck>(INBOUND.sendLocation, location);
}

/**
 * Emit with an ack, without hanging a caller for ever.
 *
 * A gateway that never acks must not wedge a screen behind a promise. The
 * fallback is a REST read, which arrives at the same answer by a slower route —
 * and `useRideTransitions` already does exactly that on a 409.
 */
function withAck<T>(event: string, body: unknown, timeoutMs = 5000): Promise<T | null> {
  return new Promise((resolve) => {
    const active = getSocket();

    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach the pending `connect` listener too. Without this, every call made
      // while the socket was down left a `once('connect')` handler that fired
      // later — after the 5s timeout had already resolved null — and re-emitted
      // the request against a socket the caller had already given up on. Location
      // frames and resyncs are both called in loops, so this accumulated.
      active.off('connect', send);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const send = () => {
      active.emit(event, body, (ack: T) => {
        // A handler that throws sends an Error over the wire, not an object.
        finish(ack && typeof ack === 'object' ? ack : null);
      });
    };

    if (active.connected) send();
    else active.once('connect', send);
  });
}

/**
 * §5.11 — the GeoUnavailable branch. A browser that will not share a position is
 * a normal outcome, not an error: permission was denied, the device is in a
 * tunnel, or the platform has no geolocation. The UI must stay usable without a
 * fix, so this resolves null rather than rejecting.
 */
export function currentPosition(options: { timeoutMs?: number } = {}): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: options.timeoutMs ?? 8000, maximumAge: 2000 },
    );
  });
}

export type { DriverLocation };
