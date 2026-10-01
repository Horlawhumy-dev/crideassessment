import type { DriverLocation, GeoPoint, Ride, RideEventLike, RideStatus, RideSnapshot } from '../types';
import { distanceMetres } from '../places';
import { isTerminal } from '../ride-status';

/**
 * §4.15, the part that is usually skipped: what a socket frame is *allowed* to
 * change in the client.
 *
 * The failure this exists to prevent is not a crash. It is a ride that says
 * "Arriving" because a status frame and a location frame each got half of the
 * transition, or because the client trusted `ride:status_changed` and painted a
 * status the server had already moved past. The rules are therefore written as
 * data — an event's `effects` say exactly which field it may touch — so the
 * answer to "what does this event do?" is a table lookup and not a recollection.
 *
 * A status frame may change a status and a driver id, and nothing else. A
 * location frame may change a coordinate and a status only through
 * `deriveStatusFromMovement`, and only forwards. Nothing in this file can invent
 * a fare, a pickup or a rider.
 *
 * Pure, and free of React and fetch, which is what makes it the part worth
 * testing.
 */

export interface RideState {
  active: Ride | null;
  driverLocation: DriverLocation | null;
  /**
   * Where the driver has been, oldest first — the path the map draws as travelled.
   *
   * A location frame overwrites `driverLocation`, so the newest fix is all the
   * state held before this existed. That is enough to move a marker and not
   * enough to draw anything: every frame erased the last one, and the map fell
   * back to a straight line between the endpoints that had no relationship to
   * where the car actually was.
   *
   * It is a property of *this* ride, so it is reset whenever the active ride
   * changes. Two rides' paths spliced together would draw a line across Osogbo
   * that no car drove.
   */
  driverPath: GeoPoint[];
  /** Newest first, capped — a live ride is not an audit log. */
  events: RideEventLike[];
  /** Highest applied seq. A frame above this by more than 1 means a gap. */
  lastSeq: number;
  /** The status the user asked for, before the server agreed. */
  pending: RideStatus | null;
  /** Set when a frame arrived we could not apply. Drives the "reconnecting" chip. */
  desynced: boolean;
  /** A frame whose `rideId` was not the active ride. Triggers a refetch. */
  staleRideIds: string[];
}

export const initialRideState: RideState = {
  active: null,
  driverLocation: null,
  driverPath: [],
  events: [],
  lastSeq: 0,
  pending: null,
  desynced: false,
  staleRideIds: [],
};

const MAX_EVENTS = 40;

/**
 * How many points a live path keeps.
 *
 * §4.9 caps the server's own buffer at 2 000 points per ride and drains it to
 * PostgreSQL at completion. A browser does not need the whole trip to draw a
 * line: at one point per server-accepted frame (3 s) an hour-long ride is 1 200.
 * The cap bounds memory on a tab left open all day, and drops from the *front* so
 * what survives is the recent end of the trip — which is the part still moving.
 */
const MAX_PATH_POINTS = 1_200;

/**
 * Movement below this does not earn a point.
 *
 * GPS jitters while stationary, and a stationary car still reports a fix. Without
 * this the path fills with hundreds of near-identical coordinates around one
 * junction, which thickens the line into a blob and makes a parked driver look
 * like they are circling.
 */
const MIN_PATH_STEP_METRES = 4;

/** Append a fix to the path, or return the same array when it adds nothing. */
function extendPath(path: GeoPoint[], location: DriverLocation): GeoPoint[] {
  const point = { lat: location.lat, lng: location.lng };
  const last = path[path.length - 1];
  if (last && distanceMetres(last, point) < MIN_PATH_STEP_METRES) return path;

  const next = [...path, point];
  return next.length > MAX_PATH_POINTS ? next.slice(next.length - MAX_PATH_POINTS) : next;
}

/** What a given event type is permitted to change. Nothing else. */
export type Effect = 'status' | 'location' | 'offer' | 'resync' | 'none';

/**
 * The real outbound names, from `RealtimeHandler`.
 *
 * The previous table listed `ride:ride_requested` and `ride:accepted`, which are
 * outbox *row* names with a colon inserted. The gateway never emits them, so
 * every one of those two listeners sat dormant: the connection worked, no frame
 * was ever delivered, and the UI only moved when a REST refetch happened to land.
 * A wrong event name is the hardest bug to notice, because nothing throws.
 */
const EFFECTS: Record<string, Effect> = {
  'ride:status_changed': 'status',
  'ride:assigned': 'status',
  'ride:offer': 'offer',
  'ride:released': 'status',
  'ride:driver_location_update': 'location',
  // Client-internal: the ack of a `ride:sync` request, not something the server
  // pushes. See INTERNAL_FRAME in realtime/socket.ts.
  'sync:applied': 'resync',
};

export type ApplyResult = {
  state: RideState;
  /** The caller must refetch. Set when a frame could not be applied authoritatively. */
  needsRefetch: boolean;
  /** The caller must show the driver a new offer in the available list. */
  isOffer: boolean;
  offerRide: Ride | null;
  /**
   * A `seq` gap was detected. The caller must issue a `ride:sync` request rather
   * than a REST refetch — it is the same snapshot, cheaper, and it tells the
   * client its `lastSeq` is now correct.
   */
  needsSync: boolean;
};

/**
 * The flat outbox payload, as it crosses the wire.
 *
 * `RealtimeHandler` builds `{ eventId, seq, rideId, ts, correlationId, ... }` and
 * the gateway emits that object *as* the payload — there is no wrapping `event`
 * key. The previous `IncomingFrame` expected `frame.event.seq`, so every seq read
 * was `undefined`: no replay protection, and the gap check could never fire
 * because `undefined > lastSeq + 1` is false. Both guards were present and inert.
 */
export interface StatusFrame {
  eventId?: string;
  seq?: number;
  rideId?: string;
  ts?: string;
  correlationId?: string;
  /** For `ride:status_changed`: the status the server moved to. */
  status?: string;
  /** For `ride:assigned`: the driver who took it. */
  driverId?: string;
}

export interface IncomingFrame extends StatusFrame {
  type: string;
  ride?: Ride;
  events?: RideEventLike[];
  location?: DriverLocation;
  lastSeq?: number;
}

/** Highest seq in a list. Events arrive ascending from the API, newest-first locally. */
export function maxSeq(events: readonly RideEventLike[] | undefined): number {
  return events?.reduce((max, e) => Math.max(max, e.seq), 0) ?? 0;
}

/**
 * Apply one frame.
 *
 * `needsRefetch` is the honest signal. `ride:status_changed` genuinely does not
 * carry the ride (no version, no fare, no addresses), so the correct response to
 * it is to note the change and ask the server for the truth — not to guess from a
 * payload that is missing everything needed to be right.
 */
export function applyFrame(state: RideState, frame: IncomingFrame): ApplyResult {
  const effect = EFFECTS[frame.type] ?? 'none';

  switch (effect) {
    case 'none':
      return { state, needsRefetch: false, isOffer: false, offerRide: null, needsSync: false };

    case 'resync':
      return { state: applyResync(state, frame), needsRefetch: false, isOffer: false, offerRide: null, needsSync: false };

    case 'offer': {
      // §4.7: the offer payload is `{ seq, rideId, fareMinor, currency }` — no
      // addresses, no distance, no fare *object*. It is a notification to go and
      // look, not a card to render, so there is no `ride` to adopt. Invalidating
      // the available list is the entire handling, and it is correct: a list
      // fetched before the offer existed cannot contain it.
      return { state, needsRefetch: true, isOffer: true, offerRide: null, needsSync: false };
    }

    case 'status':
      return applyStatusFrame(state, frame);

    case 'location':
      return applyLocationFrame(state, frame);

    default:
      return { state, needsRefetch: false, isOffer: false, offerRide: null, needsSync: false };
  }
}

function applyStatusFrame(state: RideState, frame: IncomingFrame): ApplyResult {
  const rideId = frame.rideId;
  const seq = frame.seq ?? 0;

  // §4.4.3: a frame we cannot attribute to the active ride is not a frame about
  // the active ride. Ignoring it silently would hide a real state change.
  if (state.active && rideId && rideId !== state.active.id) {
    return {
      state: { ...state, staleRideIds: [...new Set([...state.staleRideIds, rideId])] },
      needsRefetch: true,
      isOffer: false,
      offerRide: null,
      needsSync: false,
    };
  }

  // A seq we have already applied is a reconnect replay. Checked *before* the
  // event is appended: applying it twice would double-count, and re-running a
  // status transition backwards is exactly the kind of nonsense that makes a UI
  // flicker.
  if (seq > 0 && seq <= state.lastSeq) {
    return { state, needsRefetch: false, isOffer: false, offerRide: null, needsSync: false };
  }

  // A gap means frames were lost. `seq` is gapless per ride for a reason: a
  // client tracking the highest seq can detect a missed frame and resync rather
  // than assume none was dropped.
  const gap = seq > 0 && state.lastSeq > 0 && seq > state.lastSeq + 1;

  // A socket frame is not a `RideEventDto` — it is `{ seq, rideId, status }` and
  // nothing else. Rendering it in the event trail means projecting it into the
  // DTO's shape, and every field here is filled from something the server
  // actually sent. `id` and `createdAt` are reconstructed from `seq` and `ts`
  // rather than invented: this row exists to let a user read "Assigned to you",
  // and the authoritative history is one `GET /rides/{id}` away. Which is why
  // `needsRefetch` is true on every status frame.
  const event: RideEventLike = {
    id: frame.eventId ?? `socket:${rideId ?? state.active?.id ?? ''}:${seq}`,
    seq,
    rideId: rideId ?? state.active?.id,
    eventType: eventTypeForStatus(frame.status),
    actorRole: null,
    createdAt: frame.ts ?? new Date().toISOString(),
  };
  const events = [event, ...state.events].slice(0, MAX_EVENTS);

  if (gap) {
    return {
      state: { ...state, events, lastSeq: seq, desynced: true },
      needsRefetch: true,
      isOffer: false,
      offerRide: null,
      needsSync: true,
    };
  }

  // A status frame that arrives while an optimistic transition is in flight: the
  // server has spoken, so the pending marker is cleared. Leaving it set would
  // strand the button in a spinner forever.
  //
  // `ride:assigned` carries the driver id and nothing else, so it may set
  // `driverId` — but only on the active ride, which the check above enforces.
  const active =
    state.active && frame.driverId && frame.driverId !== state.active.driverId
      ? { ...state.active, driverId: frame.driverId }
      : state.active;

  return {
    state: { ...state, active, events, lastSeq: seq, pending: null, desynced: false },
    needsRefetch: true,
    isOffer: false,
    offerRide: null,
    needsSync: false,
  };
}

/** The client-side event label for a status, matching the outbox row names. */
function eventTypeForStatus(status: string | undefined): string {
  switch (status) {
    case 'ACCEPTED':
      return 'ride.accepted';
    case 'IN_PROGRESS':
      return 'ride.started';
    case 'COMPLETED':
      return 'ride.completed';
    case 'CANCELLED':
      return 'ride.cancelled';
    default:
      return 'ride.requested';
  }
}

/**
 * A location frame updates a coordinate. It does not change a status.
 *
 * The temptation is to derive "Arriving" from proximity, because the product doc
 * says so and a map makes it look achievable. But the state machine has no
 * ARRIVING state, and a status the server never sent is a status the server will
 * never confirm. A driver 300 m away is still `ACCEPTED`; the driver presses
 * "Start trip" when they are actually moving. Distance can inform copy, not the
 * machine.
 */
function applyLocationFrame(state: RideState, frame: IncomingFrame): ApplyResult {
  const location = frame.location;
  if (!location) return { state, needsRefetch: true, isOffer: false, offerRide: null, needsSync: false };

  if (state.active && location.rideId !== state.active.id) {
    return {
      state: { ...state, staleRideIds: [...new Set([...state.staleRideIds, location.rideId])] },
      needsRefetch: true,
      isOffer: false,
      offerRide: null,
      needsSync: false,
    };
  }

  // Never let a location frame resurrect a terminal ride.
  if (state.active && isTerminal(state.active.status)) {
    return { state, needsRefetch: false, isOffer: false, offerRide: null, needsSync: false };
  }

  // A fix with no ride to belong to cannot extend a path, and the ride is about to
  // be adopted — which clears the path anyway. Recording it would mean the first
  // frames of a trip were silently dropped from the line the moment the client
  // joined mid-ride, so the trail would start wherever the ride was adopted rather
  // than where the car was. The fix for that is the server replaying the track,
  // not guessing at it here.
  if (!state.active) {
    return { state, needsRefetch: false, isOffer: false, offerRide: null, needsSync: false };
  }

  return {
    state: {
      ...state,
      driverLocation: location,
      driverPath: extendPath(state.driverPath, location),
      desynced: false,
    },
    needsRefetch: false,
    isOffer: false,
    offerRide: null,
    needsSync: false,
  };
}

/**
 * A `sync:applied` frame is the only frame allowed to replace the whole ride.
 *
 * Guarded on the ride id, exactly as `reconcile` below is. Without the guard a
 * resync ack for a ride the user has already left resurrects it: the caller that
 * issued `ride:sync` for the old ride still receives its ack after the user
 * moved on, and `applyResync` has no way to tell "the ride I asked about" from
 * "the ride I am now looking at". `reconcile` already got this right, which is
 * why the two paths disagreed — one dropped a stale response, the other did not.
 */
function applyResync(state: RideState, frame: IncomingFrame): RideState {
  const ride = frame.ride;
  if (!ride) return state;
  if (state.active && state.active.id !== ride.id) return state;

  return {
    ...state,
    active: ride,
    // Same ride: keep the path, since it is the same car's track so far. A
    // different ride: it belongs to the other one and must not be drawn.
    driverPath: state.active?.id === ride.id ? state.driverPath : [],
    events: (frame.events ?? []).slice(0, MAX_EVENTS),
    lastSeq: frame.lastSeq ?? 0,
    pending: null,
    desynced: false,
  };
}

/** Install server truth. Called after any REST read, which outranks any frame. */
export function reconcile(state: RideState, snapshot: RideSnapshot | Ride): RideState {
  const ride = 'ride' in snapshot ? snapshot.ride : snapshot;

  // A response for a ride the user has moved on from must not resurrect it.
  if (state.active && state.active.id !== ride.id) return state;

  const events = 'events' in snapshot && snapshot.events ? snapshot.events : null;

  return {
    ...state,
    active: ride,
    // Only reached when the ids already agree (checked above) or there was no
    // active ride at all — in which case there is no track to inherit.
    driverPath: state.active ? state.driverPath : [],
    events: events ? events.slice(-MAX_EVENTS).reverse() : state.events,
    // The API returns events *ascending*, so the newest — and therefore the one
    // that sets lastSeq — is the last element, not the first. Using `events[0]`
    // pinned lastSeq to 1 on every refetch, which made every subsequent frame
    // look like a replay and made gap detection unreachable. Same value the
    // socket snapshot carries, preferred when present because it is authoritative
    // for the exact `after` that was requested.
    lastSeq:
      ('events' in snapshot && snapshot.lastSeq) || (events ? maxSeq(events) : state.lastSeq),
    pending: null,
    desynced: false,
  };
}

export function clearActiveRide(state: RideState): RideState {
  return { ...initialRideState };
}

/** Mark an intent so the button can respond immediately. Never authoritative. */
export function markPending(state: RideState, status: RideStatus): RideState {
  return { ...state, pending: status };
}

export function clearPending(state: RideState): RideState {
  return { ...state, pending: null };
}
