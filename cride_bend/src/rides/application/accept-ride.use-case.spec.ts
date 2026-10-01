import { AcceptRideUseCase } from './accept-ride.use-case';
import type { RideRepository } from './ports/ride.repository';
import type { OutboxPort } from './ports/outbox.port';
import type { RideEventsPort } from './ports/ride-events.port';
import type { RideCachePort } from './ports/ride-cache.port';
import { MetricsService } from '../../platform/otel/metrics';
import {
  RideAlreadyAcceptedError,
  RideNotAcceptableError,
  RideNotFoundError,
} from '../../common/errors/domain-error';
import type { Principal } from '../domain/ride-policy';
import type { Ride } from '../domain/ride';
import type { RideStatus } from '../domain/ride-status';
import {
  aRide,
  FakeCache,
  FakeEvents,
  FakeOutbox,
  FakeRideRepository,
  immediateTransaction,
} from '../../test/fakes';

/** Two drivers accepting the same ride: exactly one wins, and the loser gets a *specific*
 *  error rather than a generic 409. */
const DRIVER_A: Principal = { userId: 'driver-a', role: 'DRIVER', sessionId: 'sa' };
const DRIVER_B: Principal = { userId: 'driver-b', role: 'DRIVER', sessionId: 'sb' };
const RIDER: Principal = { userId: 'rider-1', role: 'RIDER', sessionId: 'sr' };

function build(row: Ride | null) {
  const rides = new FakeRideRepository(row);
  const outbox = new FakeOutbox();
  const events = new FakeEvents();
  const cache = new FakeCache();

  const useCase = new AcceptRideUseCase(
    rides as RideRepository,
    outbox as OutboxPort,
    events as RideEventsPort,
    cache as RideCachePort,
    immediateTransaction,
    new MetricsService(),
  );

  return { useCase, rides, outbox, events, cache };
}

describe('AcceptRideUseCase', () => {
  it('accepts an open ride and assigns the driver', async () => {
    const { useCase, rides } = build(aRide());

    const result = await useCase.execute(DRIVER_A, 'ride-1', 'corr-1');

    expect(result.status).toBe('ACCEPTED');
    expect(result.driverId).toBe('driver-a');
    expect(rides.current()?.version).toBe(2);
  });

  it('writes one event and one outbox row on success', async () => {
    const { useCase, outbox, events } = build(aRide());
    await useCase.execute(DRIVER_A, 'ride-1', 'corr-1');

    expect(outbox.events).toHaveLength(1);
    expect(outbox.events[0]).toMatchObject({
      type: 'ride.accepted',
      aggregateId: 'ride-1',
      correlationId: 'corr-1',
    });
    expect(events.appended).toHaveLength(1);
    expect(events.appended[0]).toMatchObject({ rideId: 'ride-1', actorRole: 'DRIVER' });
  });

  it('gives the event and the outbox row the same seq', async () => {
    // If these disagree, the client's gap detection sees a permanent hole and it
    // resyncs on every single event.
    const { useCase, outbox, events } = build(aRide());
    await useCase.execute(DRIVER_A, 'ride-1', 'corr-1');

    expect(outbox.events[0]!.seq).toBe(events.appended[0]!.seq);
  });

  it('invalidates the ride and the rider cache after committing', async () => {
    const { useCase, cache } = build(aRide());
    await useCase.execute(DRIVER_A, 'ride-1', 'corr-1');

    expect(cache.invalidated).toContain('ride-1');
    expect(cache.invalidatedRiders).toContain('rider-1');
  });

  it('lets exactly one of two concurrent drivers win', async () => {
    const { useCase, rides } = build(aRide());

    const results = await Promise.allSettled([
      useCase.execute(DRIVER_A, 'ride-1', 'corr-a'),
      useCase.execute(DRIVER_B, 'ride-1', 'corr-b'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(rides.current()?.driverId).toBe('driver-a');
  });

  it('tells the loser the ride was already taken', async () => {
    // Three situations get three codes so the frontend can say three things.
    const { useCase } = build(aRide());
    await useCase.execute(DRIVER_A, 'ride-1', 'corr-a');

    await expect(useCase.execute(DRIVER_B, 'ride-1', 'corr-b')).rejects.toBeInstanceOf(
      RideAlreadyAcceptedError,
    );
  });

  it('reports a non-REQUESTED ride distinctly from a taken one', async () => {
    const { useCase } = build(aRide({ status: 'CANCELLED' }));
    await expect(useCase.execute(DRIVER_A, 'ride-1', 'corr-a')).rejects.toBeInstanceOf(
      RideNotAcceptableError,
    );
  });

  it('404s a ride that does not exist', async () => {
    const { useCase } = build(null);
    await expect(useCase.execute(DRIVER_A, 'missing', 'corr-a')).rejects.toBeInstanceOf(
      RideNotFoundError,
    );
  });

  it('rejects a rider before touching the repository', async () => {
    const { useCase, rides } = build(aRide());

    await expect(useCase.execute(RIDER, 'ride-1', 'corr-a')).rejects.toMatchObject({
      code: 'FORBIDDEN_ROLE',
    });
    expect(rides.writes).toHaveLength(0);
  });

  it('writes nothing to the outbox when the accept is lost', async () => {
    const { useCase, outbox } = build(aRide());
    await useCase.execute(DRIVER_A, 'ride-1', 'corr-a');

    await expect(useCase.execute(DRIVER_B, 'ride-1', 'corr-b')).rejects.toThrow();

    // One row, not two: emitting before discovering the loss would notify a driver
    // about a ride they do not have.
    expect(outbox.events).toHaveLength(1);
  });

  it('still succeeds when the cache is unavailable', async () => {
    // A Redis outage must not become a ride outage; the cache may fail.
    const { useCase, cache } = build(aRide());
    cache.setFailing(true);

    const result = await useCase.execute(DRIVER_A, 'ride-1', 'corr-1');
    expect(result.status).toBe('ACCEPTED');
  });
});

export type { RideStatus };
