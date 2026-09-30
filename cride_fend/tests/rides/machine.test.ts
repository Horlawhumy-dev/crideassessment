import { describe, expect, it } from 'vitest';

import {
  applyFrame,
  clearActiveRide,
  initialRideState,
  markPending,
  maxSeq,
  reconcile,
  type RideState,
} from '@/lib/rides/machine';
import type { DriverLocation, Ride, RideEventLike } from '@/lib/types';

/**
 * §4.15, tested against the wire shape the server actually emits.
 *
 * These are the tests that matter most in the frontend, because the machine is
 * the one place where being wrong produces a lie rather than an error. A status
 * frame that paints a status the server never sent does not crash — it shows a
 * rider that their driver is closer than they are.
 *
 * The previous version of this file tested a contract that did not exist. It fed
 * `ride:accepted` (an outbox *row* name, never emitted) wrapped in a nested
 * `event` object that `RealtimeHandler` does not produce, and expected a
 * `ride:resync` push that the gateway never sends. All 14 tests passed and none
 * of them could ever have caught a real frame, because no real frame has the
 * shape they asserted.
 *
 * So the fixtures below are transcripts, taken from the payloads
 * `RealtimeHandler` builds. `statusFrame` is a `ride:status_changed` exactly as
 * it crosses the wire: flat, with `seq` at the top level.
 */

const RIDE: Ride = {
  id: 'ride-1',
  status: 'REQUESTED',
  version: 1,
  riderId: 'rider-1',
  driverId: null,
  pickup: { lat: 7.7714, lng: 4.5489 },
  dropoff: { lat: 7.7833, lng: 4.556 },
  pickupAddress: 'Osogbo City Mall',
  dropoffAddress: 'OSU',
  fare: { amountMinor: '10300', currency: 'NGN' },
  acceptedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledBy: null,
  cancelReason: null,
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
};

const LOCATION: DriverLocation = {
  rideId: 'ride-1',
  driverId: 'driver-1',
  lat: 7.775,
  lng: 4.551,
  heading: 45,
  speedKph: 28,
  accuracyM: 8,
  recordedAt: '2026-09-30T10:01:00.000Z',
};

function withRide(overrides: Partial<Ride> = {}): RideState {
  return { ...initialRideState, active: { ...RIDE, ...overrides } };
}

function event(seq: number, eventType: string, rideId = 'ride-1'): RideEventLike {
  return { id: `e${seq}`, seq, eventType, rideId, actorRole: 'SYSTEM', actorId: null, createdAt: '2026-09-30T10:01:00.000Z' };
}

/** A `ride:status_changed` exactly as the outbox relay emits it. */
function statusFrame(
  seq: number,
  status: string,
  rideId = 'ride-1',
): { eventId: string; seq: number; rideId: string; ts: string; correlationId: string; status: string } {
  return {
    eventId: `e${seq}`,
    seq,
    rideId,
    ts: '2026-09-30T10:01:00.000Z',
    correlationId: 'corr-1',
    status,
  };
}

/** One `ride:driver_location_update`, at a given point along the trip. */
function locationAt(lat: number, lng: number, rideId = 'ride-1'): DriverLocation {
  return { ...LOCATION, rideId, lat, lng };
}

/** Feed a list of fixes through the machine, as the socket would. */
function drive(state: RideState, ...fixes: DriverLocation[]): RideState {
  return fixes.reduce<RideState>(
    (acc, location) => applyFrame(acc, { type: 'ride:driver_location_update', location }).state,
    state,
  );
}

describe('applyFrame', () => {
  it('reports no refetch for a location frame, because a coordinate needs no server read', () => {
    const result = applyFrame(withRide(), { type: 'ride:driver_location_update', location: LOCATION });

    expect(result.needsRefetch).toBe(false);
    expect(result.state.driverLocation).toEqual(LOCATION);
  });

  /**
   * The important one. A driver 300 m from the pickup is still `ACCEPTED`; the
   * state machine has no ARRIVING state, and a status the server never sent is a
   * status the server will never confirm.
   */
  it('does not change the status from a location frame, however close the driver is', () => {
    const state = withRide({ status: 'ACCEPTED', driverId: 'driver-1' });
    const result = applyFrame(state, { type: 'ride:driver_location_update', location: LOCATION });

    expect(result.state.active?.status).toBe('ACCEPTED');
  });

  it('refetches on a status frame, because the payload carries no version or fare', () => {
    // §4.7: `ride:status_changed` has a `status` but no version, no fare and no
    // addresses. It is enough to know something changed and not enough to render
    // the ride, so the honest response is to ask the server.
    const result = applyFrame(withRide(), { type: 'ride:status_changed', ...statusFrame(1, 'ACCEPTED') });

    expect(result.needsRefetch).toBe(true);
  });

  it('treats a status frame as authoritative over a pending optimistic intent', () => {
    const pending = markPending(withRide(), 'IN_PROGRESS');
    const result = applyFrame(pending, { type: 'ride:status_changed', ...statusFrame(1, 'ACCEPTED') });

    // Otherwise the button stays in its pending state for ever.
    expect(result.state.pending).toBeNull();
  });

  it('ignores a replayed frame whose seq has already been applied', () => {
    const once = applyFrame(withRide(), { type: 'ride:status_changed', ...statusFrame(1, 'ACCEPTED') });
    const replay = applyFrame(once.state, { type: 'ride:status_changed', ...statusFrame(1, 'ACCEPTED') });

    // A reconnect replays from lastSeq. Applying twice would double-count, and
    // re-running a transition backwards is how a UI flickers.
    expect(replay.state.events).toHaveLength(1);
    expect(replay.state.lastSeq).toBe(1);
  });

  it('flags a sequence gap as desynced and asks for a socket sync', () => {
    const first = applyFrame(withRide(), { type: 'ride:status_changed', ...statusFrame(1, 'ACCEPTED') });
    const gap = applyFrame(first.state, { type: 'ride:status_changed', ...statusFrame(7, 'IN_PROGRESS') });

    // seq is gapless per ride precisely so a client can tell that it missed one.
    expect(gap.state.desynced).toBe(true);
    // A socket sync, not a REST read: `ride:sync` returns the same snapshot more
    // cheaply *and* repairs `lastSeq`, which a REST read has to re-derive.
    expect(gap.needsSync).toBe(true);
    expect(gap.needsRefetch).toBe(true);
  });

  it('does not flag a gap when the ride has no history yet', () => {
    // lastSeq is 0 on a ride the client has only just heard about, so seq 7 is
    // the first frame, not the eighth. Treating that as a gap would resync on
    // every first frame of every ride.
    const result = applyFrame(withRide(), { type: 'ride:status_changed', ...statusFrame(7, 'ACCEPTED') });

    expect(result.state.desynced).toBe(false);
    expect(result.needsSync).toBe(false);
    expect(result.state.lastSeq).toBe(7);
  });

  it('does not apply a frame for a different ride to the active one', () => {
    const state = withRide();
    const result = applyFrame(state, { type: 'ride:status_changed', ...statusFrame(1, 'ACCEPTED', 'ride-2') });

    expect(result.state.active?.id).toBe('ride-1');
    expect(result.state.staleRideIds).toContain('ride-2');
    expect(result.needsRefetch).toBe(true);
  });

  it('never lets a location frame resurrect a completed ride', () => {
    const completed = withRide({ status: 'COMPLETED', driverId: 'driver-1' });
    const result = applyFrame(completed, { type: 'ride:driver_location_update', location: LOCATION });

    expect(result.state.driverLocation).toBeNull();
  });

  it('surfaces an offer as an offer, and asks for the list to be refetched', () => {
    // The real offer payload: `{ seq, rideId, fareMinor, currency }`.
    const result = applyFrame(initialRideState, {
      type: 'ride:offer',
      seq: 1,
      rideId: 'ride-1',
    });

    // §4.7: an offer carries no pickup, no distance and no fare object, so it
    // cannot be rendered as a card. It is a reason to go and look — which is why
    // `offerRide` is null and never a half-renderable ride.
    expect(result.isOffer).toBe(true);
    expect(result.offerRide).toBeNull();
    expect(result.needsRefetch).toBe(true);
  });

  it('adopts the driver id from ride:assigned', () => {
    // The one status-shaped frame that carries something new, and the only legal
    // writer of `driverId` on the active ride.
    const result = applyFrame(withRide({ status: 'ACCEPTED' }), {
      type: 'ride:assigned',
      ...statusFrame(2, 'ACCEPTED'),
      driverId: 'driver-9',
    });

    expect(result.state.active?.driverId).toBe('driver-9');
  });

  it('applies a sync ack wholesale, because it is the only frame allowed to', () => {
    // `sync:applied` is the internal name for the ack of a `ride:sync` request.
    // There is no `ride:resync` push to wait for, which is why the provider
    // issues the request and feeds the answer in here.
    const result = applyFrame(withRide(), {
      type: 'sync:applied',
      ride: { ...RIDE, status: 'IN_PROGRESS', version: 3, driverId: 'driver-1' },
      events: [event(3, 'ride.started'), event(2, 'ride.accepted'), event(1, 'ride.accepted')],
      lastSeq: 3,
    });

    expect(result.state.active?.status).toBe('IN_PROGRESS');
    expect(result.state.lastSeq).toBe(3);
    expect(result.state.events).toHaveLength(3);
  });

  it('ignores a frame type it does not know rather than guessing', () => {
    const state = withRide();
    const result = applyFrame(state, { type: 'ride:something_new', ...statusFrame(1, 'ACCEPTED') });

    expect(result.state).toBe(state);
    expect(result.needsRefetch).toBe(false);
  });
});

describe('reconcile', () => {
  it('installs server truth and clears a pending intent', () => {
    const pending = markPending(withRide(), 'COMPLETED');
    const result = reconcile(pending, { ...RIDE, status: 'COMPLETED', version: 2 });

    expect(result.active?.version).toBe(2);
    expect(result.pending).toBeNull();
  });

  it('refuses a response for a ride the user has moved on from', () => {
    const state = withRide({ id: 'ride-1' });
    const stale = reconcile(state, { ...RIDE, id: 'ride-2', status: 'COMPLETED' });

    // A late response for a superseded ride must not resurrect it.
    expect(stale).toBe(state);
  });

  /**
   * The subtle one, and it is worth the two lines to explain.
   *
   * `GET /rides/{id}` returns its events **ascending** — `ride.requested` first,
   * `ride.completed` last. The provider used to read `lastSeq` from
   * `events[0].seq`, which is `ride.requested`, so every refetch reset `lastSeq`
   * to 1. From then on every real frame looked like a replay (seq <= lastSeq),
   * was dropped by the guard above, and the event trail stayed frozen at
   * "requested" for the whole ride while the status silently came from REST.
   *
   * So this asserts the derived value, not the rendering: the highest seq must
   * survive an ascending list.
   */
  it('derives lastSeq from the highest seq, not the first, on an ascending event list', () => {
    const result = reconcile(withRide(), {
      ride: { ...RIDE, status: 'COMPLETED', version: 4 },
      events: [
        event(1, 'ride.requested'),
        event(2, 'ride.accepted'),
        event(3, 'ride.started'),
        event(4, 'ride.completed'),
      ],
      lastSeq: 4,
    });

    expect(result.lastSeq).toBe(4);
  });

  it('recovers lastSeq from the events alone when the caller has no snapshot seq', () => {
    // A `GET /rides/{id}` response carries no `lastSeq` field — it is a socket
    // snapshot concept. So the derivation has to work without one, which is the
    // case the bug above actually hit.
    const result = reconcile(withRide(), {
      ride: { ...RIDE, status: 'IN_PROGRESS', version: 3 },
      events: [event(1, 'ride.requested'), event(2, 'ride.accepted'), event(3, 'ride.started')],
    } as never);

    expect(result.lastSeq).toBe(3);
  });

  it('presents the trail newest first, however the server ordered it', () => {
    // Local state is newest-first so the UI renders `[0]` at the top. The server
    // sends ascending, so reconcile reverses — a missed reversal shows a rider
    // the oldest event of their ride as the most recent thing that happened.
    const result = reconcile(withRide(), {
      ride: RIDE,
      events: [event(1, 'ride.requested'), event(2, 'ride.accepted')],
      lastSeq: 2,
    });

    expect(result.events.map((e) => e.seq)).toEqual([2, 1]);
  });
});

/**
 * The travelled path.
 *
 * `driverLocation` overwrites, so before this existed the state held exactly one
 * position and the map drew a line that bore no relation to where the car was.
 * These assert the accumulation: it grows, it keeps its order, it ignores jitter,
 * and — the one that would be invisible on screen — it does not survive a change
 * of ride.
 */
describe('driverPath', () => {
  it('accumulates every accepted fix, oldest first', () => {
    const state = drive(withRide({ status: 'IN_PROGRESS', driverId: 'driver-1' }),
      locationAt(7.772, 4.549),
      locationAt(7.774, 4.551),
      locationAt(7.776, 4.553),
    );

    expect(state.driverPath).toEqual([
      { lat: 7.772, lng: 4.549 },
      { lat: 7.774, lng: 4.551 },
      { lat: 7.776, lng: 4.553 },
    ]);
    // The newest fix is still the live one. The path is additive, not a replacement.
    expect(state.driverLocation?.lat).toBe(7.776);
  });

  it('ignores movement too small to be the car moving', () => {
    // ~1 m apart. A stationary driver still reports a fix, and a phone's jitter is
    // metres; accepting these fills the line with a blob around one junction and
    // makes a parked car look like it is circling.
    const state = drive(withRide({ status: 'IN_PROGRESS', driverId: 'driver-1' }),
      locationAt(7.772, 4.549),
      locationAt(7.77201, 4.549),
      locationAt(7.772, 4.549005),
    );

    expect(state.driverPath).toHaveLength(1);
  });

  it('does not grow while the driver sits still, so a redraw costs nothing', () => {
    const moving = drive(withRide({ status: 'IN_PROGRESS', driverId: 'driver-1' }), locationAt(7.772, 4.549));
    const parked = drive(moving, locationAt(7.772, 4.549), locationAt(7.772, 4.549));

    // Same reference: `extendPath` returns the array it was given when nothing was
    // added, which is what keeps this from re-rendering the map every 3 s for a
    // driver waiting at a traffic light.
    expect(parked.driverPath).toBe(moving.driverPath);
  });

  it('never lets one ride’s path be drawn on another’s map', () => {
    const first = drive(withRide({ status: 'IN_PROGRESS', driverId: 'driver-1' }),
      locationAt(7.772, 4.549),
      locationAt(7.774, 4.551),
    );
    const next = reconcile(first, { ...RIDE, id: 'ride-2', status: 'ACCEPTED', driverId: 'driver-2' });

    // `reconcile` refuses a different ride's response outright, so the way a new
    // ride actually arrives is through the socket snapshot.
    expect(next).toBe(first);

    const resynced = applyFrame(first, {
      type: 'sync:applied',
      ride: { ...RIDE, id: 'ride-2', status: 'ACCEPTED', driverId: 'driver-2' },
      events: [event(1, 'ride.requested')],
      lastSeq: 1,
    }).state;

    expect(resynced.driverPath).toEqual([]);
  });

  it('keeps the path through a resync of the same ride', () => {
    // A reconnect replays the snapshot. That is the same car on the same trip, so
    // clearing here would erase the rider's line every time the socket blipped.
    const driven = drive(withRide({ status: 'IN_PROGRESS', driverId: 'driver-1' }),
      locationAt(7.772, 4.549),
      locationAt(7.774, 4.551),
    );
    const resynced = applyFrame(driven, {
      type: 'sync:applied',
      ride: { ...RIDE, status: 'IN_PROGRESS', version: 3, driverId: 'driver-1' },
      events: [event(2, 'ride.started')],
      lastSeq: 2,
    }).state;

    expect(resynced.driverPath).toEqual(driven.driverPath);
  });

  it('keeps the path when a REST refetch reconciles the same ride', () => {
    // `refetchActiveRide` runs on every status frame, so this is the common path,
    // not an edge case. A refetch that emptied the line would erase it several
    // times over the course of one ride.
    const driven = drive(withRide({ status: 'IN_PROGRESS', driverId: 'driver-1' }), locationAt(7.772, 4.549));
    const refetched = reconcile(driven, { ...RIDE, status: 'IN_PROGRESS', version: 4, driverId: 'driver-1' });

    expect(refetched.driverPath).toEqual(driven.driverPath);
  });

  it('does not extend a completed ride’s path', () => {
    const done = applyFrame(withRide({ status: 'COMPLETED', driverId: 'driver-1' }), {
      type: 'ride:driver_location_update',
      location: locationAt(7.776, 4.553),
    }).state;

    expect(done.driverPath).toEqual([]);
  });

  it('does not extend the path for a frame about another ride', () => {
    const result = applyFrame(withRide(), {
      type: 'ride:driver_location_update',
      location: locationAt(7.776, 4.553, 'ride-2'),
    });

    expect(result.state.driverPath).toEqual([]);
  });
});

describe('maxSeq', () => {
  it('is zero for nothing, and the maximum for an unsorted list', () => {
    expect(maxSeq(undefined)).toBe(0);
    expect(maxSeq([])).toBe(0);
    expect(maxSeq([event(3, 'ride.started'), event(1, 'ride.requested'), event(2, 'ride.accepted')])).toBe(3);
  });
});

describe('clearActiveRide', () => {
  it('resets to the initial state', () => {
    const dirty = withRide({ status: 'IN_PROGRESS' });
    expect(clearActiveRide(dirty)).toEqual(initialRideState);
  });
});
