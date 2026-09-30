import {
  assertCanAccept,
  assertCanCancel,
  assertCanTransition,
  assertCanView,
  assertRole,
  canPublishLocation,
  canSubscribeToRide,
  type Principal,
} from './ride-policy';
import type { Ride } from './ride';
import { InvalidTransitionError, type RideStatus } from './ride-status';

/** The authorization matrix, asserted over (ride, principal) with no HTTP or database. */
const RIDER_ID = 'rider-1';
const DRIVER_ID = 'driver-1';
const STRANGER_ID = 'rider-2';

const rider: Principal = { userId: RIDER_ID, role: 'RIDER', sessionId: 's1' };
const driver: Principal = { userId: DRIVER_ID, role: 'DRIVER', sessionId: 's2' };
const stranger: Principal = { userId: STRANGER_ID, role: 'RIDER', sessionId: 's3' };

function ride(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 'ride-1',
    riderId: RIDER_ID,
    driverId: null,
    status: 'REQUESTED',
    version: 1,
    pickup: { lat: 0, lng: 0 },
    dropoff: { lat: 1, lng: 1 },
    pickupAddress: null,
    dropoffAddress: null,
    fare: null,
    cancelledBy: null,
    cancelReason: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const assigned = (status: RideStatus = 'ACCEPTED') =>
  ride({ driverId: DRIVER_ID, status, version: 2 });

describe('assertCanView', () => {
  it('allows the rider', () => expect(() => assertCanView(ride(), rider)).not.toThrow());
  it('allows the assigned driver', () =>
    expect(() => assertCanView(assigned(), driver)).not.toThrow());
  it('rejects an unrelated user', () =>
    expect(() => assertCanView(assigned(), stranger)).toThrow());

  it('throws a 404-shaped error rather than 403, so it is not an enumeration oracle', () => {
    try {
      assertCanView(assigned(), stranger);
      throw new Error('should not reach');
    } catch (err) {
      expect((err as { code: string }).code).toBe('RIDE_NOT_VISIBLE');
    }
  });
});

describe('assertRole', () => {
  it('rejects the wrong role', () => expect(() => assertRole(rider, 'DRIVER')).toThrow());
  it('accepts the right role', () => expect(() => assertRole(driver, 'DRIVER')).not.toThrow());
});

describe('assertCanAccept', () => {
  it('allows a driver to accept a REQUESTED ride', () =>
    expect(() => assertCanAccept(ride(), driver)).not.toThrow());

  it('rejects a rider', () => expect(() => assertCanAccept(ride(), rider)).toThrow());

  it('rejects a second driver', () =>
    expect(() => assertCanAccept(assigned(), { ...driver, userId: 'driver-2' })).toThrow());

  it('rejects an already-advanced ride', () =>
    expect(() => assertCanAccept(ride({ status: 'IN_PROGRESS' }), driver)).toThrow());

  it('rejects a cancelled ride', () =>
    expect(() => assertCanAccept(ride({ status: 'CANCELLED' }), driver)).toThrow());
});

/** Cancellation is the asymmetric one, so these are the assertions that matter most. */
describe('assertCanCancel', () => {
  it('allows the rider to cancel before a driver is assigned', () =>
    expect(() => assertCanCancel(ride(), rider)).not.toThrow());

  it('refuses a rider who is not the rider of record', () =>
    expect(() => assertCanCancel(ride(), stranger)).toThrow());

  it('allows the assigned driver to cancel the ride they hold', () => {
    expect(() => assertCanCancel(assigned('ACCEPTED'), driver)).not.toThrow();
    expect(() => assertCanCancel(assigned('IN_PROGRESS'), driver)).not.toThrow();
  });

  it('refuses a driver who was not assigned', () => {
    // The offer reaches every driver, so "I saw it" must not be enough to end a trip.
    expect(() => assertCanCancel(assigned(), { ...driver, userId: 'driver-9' })).toThrow();
  });

  /** Cancellation must depend on the ride, not just the role. */
  it('refuses a rider who tries to cancel after a driver has committed', () => {
    for (const status of ['ACCEPTED', 'IN_PROGRESS'] as const) {
      expect(() => assertCanCancel(assigned(status), rider)).toThrow(InvalidTransitionError);
    }
  });

  it('refuses a driver on a ride that has already finished', () => {
    // Terminal rides are rejected here too rather than assumed handled upstream.
    expect(() => assertCanCancel(assigned('COMPLETED'), driver)).toThrow(InvalidTransitionError);
    expect(() => assertCanCancel(assigned('CANCELLED'), driver)).toThrow(InvalidTransitionError);
  });

  it('reports a wrong moment as a transition error, not a permissions error', () => {
    // 409 and 403 are different answers: "try again later" vs "this is not yours".
    try {
      assertCanCancel(assigned('ACCEPTED'), rider);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).code).toBe('INVALID_TRANSITION');
    }
  });
});

describe('assertCanTransition', () => {
  it('lets the driver start an assigned ride', () =>
    expect(() => assertCanTransition(assigned(), driver, 'IN_PROGRESS')).not.toThrow());

  it('refuses a driver who is not the assigned one', () =>
    expect(() => assertCanTransition(assigned(), { ...driver, userId: 'driver-9' }, 'IN_PROGRESS'))
      .toThrow());

  it('refuses a rider driving a ride forward', () =>
    expect(() => assertCanTransition(assigned(), rider, 'IN_PROGRESS')).toThrow());

  it('refuses a stranger entirely', () =>
    expect(() => assertCanTransition(assigned(), stranger, 'COMPLETED')).toThrow());

  /** The cancellation check must precede the status-blind DRIVER early return. */
  it('routes a driver cancellation through the cancellation rules', () => {
    expect(() => assertCanTransition(assigned('IN_PROGRESS'), driver, 'CANCELLED')).not.toThrow();
    expect(() => assertCanTransition(assigned('COMPLETED'), driver, 'CANCELLED')).toThrow();
    expect(() => assertCanTransition(assigned(), { ...driver, userId: 'driver-9' }, 'CANCELLED')).toThrow();
  });
});

describe('canSubscribeToRide', () => {
  it('allows both participants', () => {
    expect(canSubscribeToRide(assigned(), rider)).toBe(true);
    expect(canSubscribeToRide(assigned(), driver)).toBe(true);
  });

  it('refuses a non-participant', () =>
    expect(canSubscribeToRide(assigned(), stranger)).toBe(false));

  it('refuses a driver before assignment, so offers do not leak ride details', () =>
    expect(canSubscribeToRide(ride(), driver)).toBe(false));
});

describe('canPublishLocation', () => {
  it('allows the assigned driver while ACCEPTED', () =>
    expect(canPublishLocation(assigned('ACCEPTED'), driver, 'ACCEPTED')).toBe(true));

  it('allows the assigned driver while IN_PROGRESS', () =>
    expect(canPublishLocation(assigned('IN_PROGRESS'), driver, 'IN_PROGRESS')).toBe(true));

  it('refuses once the ride is COMPLETED', () =>
    expect(canPublishLocation(assigned('COMPLETED'), driver, 'COMPLETED')).toBe(false));

  it('refuses a driver who is not assigned', () =>
    expect(
      canPublishLocation(assigned(), { ...driver, userId: 'driver-9' }, 'ACCEPTED'),
    ).toBe(false));

  it('refuses a rider', () =>
    expect(canPublishLocation(assigned(), rider, 'ACCEPTED')).toBe(false));
});
