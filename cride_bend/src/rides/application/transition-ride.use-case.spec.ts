import { TransitionRideUseCase } from './transition-ride.use-case';
import type { RideRepository } from './ports/ride.repository';
import type { OutboxPort } from './ports/outbox.port';
import type { RideEventsPort } from './ports/ride-events.port';
import type { RideCachePort } from './ports/ride-cache.port';
import { MetricsService } from '../../platform/otel/metrics';
import { RideVersionConflictError } from '../../common/errors/domain-error';
import type { Principal } from '../domain/ride-policy';
import type { Ride } from '../domain/ride';
import {
  aRide,
  FakeCache,
  FakeEvents,
  FakeOutbox,
  FakeRideRepository,
  immediateTransaction,
} from '../../test/fakes';

/** Optimistic concurrency on the generic transition path. */
const RIDER: Principal = { userId: 'rider-1', role: 'RIDER', sessionId: 'sr' };
const DRIVER: Principal = { userId: 'driver-1', role: 'DRIVER', sessionId: 'sd' };
const OTHER_DRIVER: Principal = { userId: 'driver-9', role: 'DRIVER', sessionId: 'so' };

function build(row: Ride | null) {
  const rides = new FakeRideRepository(row);
  const outbox = new FakeOutbox();
  const events = new FakeEvents();
  const cache = new FakeCache();

  const useCase = new TransitionRideUseCase(
    rides as RideRepository,
    outbox as OutboxPort,
    events as RideEventsPort,
    cache as RideCachePort,
    immediateTransaction,
    new MetricsService(),
  );

  return { useCase, rides, outbox, events, cache };
}

const accepted = (overrides: Partial<Ride> = {}) =>
  aRide({ driverId: 'driver-1', status: 'ACCEPTED', version: 2, ...overrides });

describe('TransitionRideUseCase', () => {
  it('lets the assigned driver start the ride', async () => {
    const { useCase } = build(accepted());
    const result = await useCase.execute(DRIVER, 'ride-1', { to: 'IN_PROGRESS' }, 'c1');

    expect(result.status).toBe('IN_PROGRESS');
    expect(result.startedAt).not.toBeNull();
  });

  it('emits the started event exactly once', async () => {
    const { useCase, outbox } = build(accepted());
    await useCase.execute(DRIVER, 'ride-1', { to: 'IN_PROGRESS' }, 'c1');

    expect(outbox.events.map((e) => e.type)).toEqual(['ride.started']);
  });

  it('completes the ride and stamps the completion time', async () => {
    const { useCase } = build(accepted({ status: 'IN_PROGRESS', version: 3 }));
    const result = await useCase.execute(DRIVER, 'ride-1', { to: 'COMPLETED' }, 'c1');

    expect(result.status).toBe('COMPLETED');
    expect(result.completedAt).not.toBeNull();
  });

  it('lets the rider cancel an unassigned ride and records who did it', async () => {
    const { useCase } = build(aRide());
    const result = await useCase.execute(
      RIDER,
      'ride-1',
      { to: 'CANCELLED', reason: 'changed my mind' },
      'c1',
    );

    expect(result.status).toBe('CANCELLED');
    // The reason the repository takes an `actor` rather than hardcoding RIDER.
    expect(result.cancelledBy).toBe('RIDER');
    expect(result.cancelReason).toBe('changed my mind');
  });

  it('refuses a stale version rather than clobbering a newer state', async () => {
    // The whole point of `version`: a tab left open while someone else moved the ride
    // on gets a 409, not a silent overwrite.
    const { useCase, rides } = build(accepted());

    await expect(
      useCase.execute(DRIVER, 'ride-1', { to: 'IN_PROGRESS', version: 1 }, 'c1'),
    ).rejects.toBeInstanceOf(RideVersionConflictError);

    expect(rides.current()?.status).toBe('ACCEPTED');
  });

  it('accepts a matching version', async () => {
    const { useCase } = build(accepted());
    await expect(
      useCase.execute(DRIVER, 'ride-1', { to: 'IN_PROGRESS', version: 2 }, 'c1'),
    ).resolves.toMatchObject({ status: 'IN_PROGRESS' });
  });

  it('hides the ride from a driver who is not the assigned one', async () => {
    // 404, not 403: a non-assigned driver is not a participant, so 403 would confirm
    // the ride exists and turn accept into a way to enumerate open rides and drivers.
    const { useCase, outbox } = build(accepted());
    await expect(
      useCase.execute(OTHER_DRIVER, 'ride-1', { to: 'IN_PROGRESS' }, 'c1'),
    ).rejects.toMatchObject({ code: 'RIDE_NOT_VISIBLE' });
    expect(outbox.events).toHaveLength(0);
  });

  it('rejects an illegal edge', async () => {
    // REQUESTED -> COMPLETED: the ride never got a driver, so there is no trip to
    // complete.
    const { useCase } = build(accepted());
    await expect(
      useCase.execute(DRIVER, 'ride-1', { to: 'COMPLETED' }, 'c1'),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('lets the assigned driver cancel, and records that a driver did', async () => {
    // A driver who cannot end a trip they are on leaves the rider waiting for
    // something that is never going to happen.
    const { useCase, rides, outbox, events } = build(accepted());
    const result = await useCase.execute(DRIVER, 'ride-1', { to: 'CANCELLED', reason: 'vehicle broke down' }, 'c1');

    expect(result.status).toBe('CANCELLED');
    expect(rides.current()?.cancelledBy).toBe('DRIVER');
    expect(rides.current()?.cancelReason).toBe('vehicle broke down');
    // Still stamped on the row: the driver is a fact about the trip, not something
    // the cancellation erases. Migration 0004 relaxes the CHECK constraint so this
    // can be true.
    expect(rides.current()?.driverId).toBe('driver-1');
    expect(outbox.events.map((e) => e.type)).toContain('ride.cancelled');
    expect(events.appended.map((e) => e.eventType)).toContain('ride.cancelled');
    // The audit trail names who acted, so "the trip vanished" is never all a rider
    // or support can learn.
    expect(events.appended.at(-1)?.actorRole).toBe('DRIVER');
  });

  it('refuses a driver cancelling a ride they are not on', async () => {
    // `ride:offer` reaches every available driver, so "I saw this request" must not be
    // enough to end a trip.
    const { useCase, outbox } = build(accepted());
    await expect(
      useCase.execute(OTHER_DRIVER, 'ride-1', { to: 'CANCELLED' }, 'c1'),
    ).rejects.toMatchObject({ code: 'RIDE_NOT_VISIBLE' });
    expect(outbox.events).toHaveLength(0);
  });

  it('rejects a rider trying to drive the ride forward', async () => {
    const { useCase } = build(accepted());
    await expect(
      useCase.execute(RIDER, 'ride-1', { to: 'IN_PROGRESS' }, 'c1'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_ROLE' });
  });

  it('rejects a non-participant', async () => {
    const { useCase } = build(accepted());
    await expect(
      useCase.execute({ ...RIDER, userId: 'stranger' }, 'ride-1', { to: 'CANCELLED' }, 'c1'),
    ).rejects.toMatchObject({ code: 'RIDE_NOT_VISIBLE' });
  });

  it('bumps the version on every successful transition', async () => {
    const { useCase, rides } = build(accepted());
    await useCase.execute(DRIVER, 'ride-1', { to: 'IN_PROGRESS' }, 'c1');
    expect(rides.current()?.version).toBe(3);
  });
});
