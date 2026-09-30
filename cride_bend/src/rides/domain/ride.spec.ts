import { assignDriver, canBeCancelled, durationMs, transition, type Ride } from './ride';
import { InvalidTransitionError, WrongActorError } from './ride-status';

const NOW = new Date('2026-03-01T12:00:00Z');

function ride(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 'ride-1',
    riderId: 'rider-1',
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('transition', () => {
  it('bumps the version, which is what makes the optimistic update meaningful', () => {
    expect(transition(ride(), 'CANCELLED', 'RIDER', NOW).version).toBe(2);
  });

  it('does not mutate the input', () => {
    // Immutability lets a use-case keep a pre-image for the audit trail and conflict
    // detection without a defensive copy.
    const before = ride();
    const after = transition(before, 'CANCELLED', 'RIDER', NOW);
    expect(before.status).toBe('REQUESTED');
    expect(before.version).toBe(1);
    expect(after).not.toBe(before);
  });

  it('stamps the timestamp belonging to the target status', () => {
    const accepted = assignDriver(ride(), 'driver-1', NOW);
    expect(accepted.acceptedAt).toEqual(NOW);
    expect(accepted.startedAt).toBeNull();

    const started = transition(accepted, 'IN_PROGRESS', 'DRIVER', NOW);
    expect(started.startedAt).toEqual(NOW);

    const done = transition(started, 'COMPLETED', 'DRIVER', NOW);
    expect(done.completedAt).toEqual(NOW);
  });

  it('records who cancelled', () => {
    expect(transition(ride(), 'CANCELLED', 'RIDER', NOW).cancelledBy).toBe('RIDER');
  });

  it('refuses an illegal edge', () => {
    expect(() => transition(ride(), 'COMPLETED', 'DRIVER', NOW)).toThrow(
      InvalidTransitionError,
    );
  });

  it('refuses the wrong actor', () => {
    expect(() => transition(ride(), 'ACCEPTED', 'RIDER', NOW)).toThrow(WrongActorError);
  });
});

describe('assignDriver', () => {
  it('attaches the driver in the same step as the status change', () => {
    // Two writes would leave a window where the ride is ACCEPTED with no driver.
    const accepted = assignDriver(ride(), 'driver-1', NOW);
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.driverId).toBe('driver-1');
  });

  it('refuses to overwrite an existing driver', () => {
    expect(() => assignDriver(ride({ driverId: 'driver-9' }), 'driver-1', NOW)).toThrow();
  });
});

describe('canBeCancelled', () => {
  it.each(['REQUESTED', 'ACCEPTED', 'IN_PROGRESS'] as const)('is true for %s', (status) => {
    expect(canBeCancelled(ride({ status }))).toBe(true);
  });

  it.each(['COMPLETED', 'CANCELLED'] as const)('is false for %s', (status) => {
    expect(canBeCancelled(ride({ status }))).toBe(false);
  });
});

describe('durationMs', () => {
  it('is null until the ride completes', () => {
    expect(durationMs(ride())).toBeNull();
  });

  it('measures from the start of the trip, not the request', () => {
    const start = new Date('2026-03-01T12:00:00Z');
    const end = new Date('2026-03-01T12:18:00Z');
    const completed = ride({
      status: 'COMPLETED',
      startedAt: start,
      completedAt: end,
    });
    // 18 minutes; measuring from createdAt would include the driver's approach.
    expect(durationMs(completed)).toBe(18 * 60 * 1000);
  });
});
