import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../kernel/transaction';
import { MetricsService } from '../../platform/otel/metrics';
import { RiderHasActiveRideError } from '../../common/errors/domain-error';
import { assertRole, type Principal } from '../domain/ride-policy';
import { assertValidPoint } from '../../kernel/geo-point';
import { InvalidCoordinatesError } from '../../common/errors/domain-error';
import { estimateDurationMs, estimateFare, type FarePolicy } from '../domain/fare';
import type { Ride } from '../domain/ride';
import { FARE_POLICY } from './fare-policy.provider';
import { RIDE_REPOSITORY, type RideRepository } from './ports/ride.repository';
import { OUTBOX_PORT, type OutboxPort } from './ports/outbox.port';
import { RIDE_EVENTS_PORT, type RideEventsPort } from './ports/ride-events.port';
import { RIDE_CACHE_PORT, type RideCachePort } from './ports/ride-cache.port';
import type { RequestRideDto } from '../dto/request-ride.dto';

export interface RequestRideResult {
  readonly ride: Ride;
  readonly estimatedDurationMs: number;
}

/**
 * §4.5.3 — the request path, end to end.
 *
 * The transaction is steps 4-5 and nothing else. Cache invalidation happens after
 * COMMIT and is explicitly allowed to fail, because the outbox relay retries
 * delivery and the cache self-heals via TTL. Nothing after COMMIT is on the
 * critical path of correctness — that is P1 made concrete.
 */
@Injectable()
export class RequestRideUseCase {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly rides: RideRepository,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort,
    @Inject(RIDE_EVENTS_PORT) private readonly events: RideEventsPort,
    @Inject(RIDE_CACHE_PORT) private readonly cache: RideCachePort,
    @Inject(TRANSACTION_RUNNER) private readonly tx: TransactionRunner,
    @Inject(FARE_POLICY) private readonly farePolicy: FarePolicy,
    private readonly metrics: MetricsService,
  ) {}

  async execute(principal: Principal, dto: RequestRideDto, correlationId: string): Promise<RequestRideResult> {
    assertRole(principal, 'RIDER');
    // assertValidPoint is a kernel guard; translate its failure into a DomainError
    // so the filter can answer 400 with a code rather than leaking a 500.
    for (const point of [dto.pickup, dto.dropoff]) {
      try {
        assertValidPoint(point);
      } catch {
        throw new InvalidCoordinatesError(point?.lat, point?.lng);
      }
    }

    const existing = await this.rides.findActiveByRider(principal.userId);
    if (existing) throw new RiderHasActiveRideError(principal.userId, existing.id);

    const fare = estimateFare(
      {
        pickup: dto.pickup,
        dropoff: dto.dropoff,
        durationMs: estimateDurationMs(dto.pickup, dto.dropoff),
      },
      this.farePolicy,
    );
    const estimatedDurationMs = estimateDurationMs(dto.pickup, dto.dropoff);
    const now = new Date();
    const rideId = randomUUID();

    const ride = await this.tx.run(async (tx) => {
      const created = await this.rides.create(tx, {
        id: rideId,
        riderId: principal.userId,
        pickup: dto.pickup,
        dropoff: dto.dropoff,
        pickupAddress: dto.pickupAddress ?? null,
        dropoffAddress: dto.dropoffAddress ?? null,
        fare,
        now,
      });

      await this.events.append({
        tx,
        rideId,
        seq: 1,
        eventType: 'ride.requested',
        actorId: principal.userId,
        actorRole: 'RIDER',
        payload: { fareMinor: fare.amountMinor.toString(), currency: fare.currency },
      });

      await this.outbox.enqueue(tx, {
        type: 'ride.requested',
        aggregateId: created.id,
        seq: 1,
        correlationId,
        payload: { rideId: created.id, riderId: principal.userId },
      });

      return created;
    });

    // Post-commit, best-effort. Every DEL is also covered by the TTL.
    await this.cache.invalidateRider(principal.userId).catch(() => undefined);

    this.metrics.counter('ride_requests_total').inc();
    return { ride, estimatedDurationMs };
  }
}
