import { Inject, Injectable } from '@nestjs/common';
import { RideNotFoundError, RideVersionConflictError } from '../../common/errors/domain-error';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../kernel/transaction';
import { MetricsService } from '../../platform/otel/metrics';
import { assertCanTransition, assertCanView, type Principal } from '../domain/ride-policy';
import { assertTransition, InvalidTransitionError, isTerminal } from '../domain/ride-status';
import type { Ride } from '../domain/ride';
import { RIDE_REPOSITORY, type RideRepository } from './ports/ride.repository';
import { OUTBOX_PORT, type OutboxPort } from './ports/outbox.port';
import { RIDE_EVENTS_PORT, type RideEventsPort } from './ports/ride-events.port';
import { RIDE_CACHE_PORT, type RideCachePort } from './ports/ride-cache.port';
import type { TransitionRideDto } from '../dto/transition-ride.dto';

const EVENT_FOR_STATUS = {
  ACCEPTED: 'ride.accepted',
  IN_PROGRESS: 'ride.started',
  COMPLETED: 'ride.completed',
  CANCELLED: 'ride.cancelled',
} as const;

/** The generic transition path, guarded by `version`: a stale caller gets
 *  RIDE_VERSION_CONFLICT rather than last-writer-wins. `ride:transition` calls this too. */
@Injectable()
export class TransitionRideUseCase {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly rides: RideRepository,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort,
    @Inject(RIDE_EVENTS_PORT) private readonly events: RideEventsPort,
    @Inject(RIDE_CACHE_PORT) private readonly cache: RideCachePort,
    @Inject(TRANSACTION_RUNNER) private readonly tx: TransactionRunner,
    private readonly metrics: MetricsService,
  ) {}

  async execute(
    principal: Principal,
    rideId: string,
    dto: TransitionRideDto,
    correlationId: string,
  ): Promise<Ride> {
    const now = new Date();

    const ride = await this.tx.run(async (tx) => {
      const current = await this.rides.findById(rideId, tx);
      if (!current) throw new RideNotFoundError(rideId);

      // The order of these four checks is the contract: each answers a different
      // question, and the four return different codes.
      //
      // 1. Visibility, first. 404 rather than 403, since 403 confirms the ride exists.
      assertCanView(current, principal);

      // 2. Terminality before actor policy: a terminal ride admits no transition from
      //    anyone, and `assertCanTransition` would report RIDE_ALREADY_ACCEPTED for a
      //    ride that finished an hour ago.
      if (isTerminal(current.status)) {
        throw new InvalidTransitionError(current.status, dto.to);
      }

      // 3. The version guard before the state table. Under READ COMMITTED the read
      //    above can observe a *competitor's committed* transition, so the loser would
      //    be told INVALID_TRANSITION — which tells the caller to stop retrying when
      //    the right answer is to refetch. Omitting `version` is last-writer-wins.
      if (dto.version !== undefined && dto.version !== current.version) {
        this.metrics.counter('ride_status_transition_errors').inc({ reason: 'version_conflict' });
        throw new RideVersionConflictError(rideId, dto.version, current.version);
      }

      // 4. Actor policy before legality, so a rider driving a ride forward is told
      //    FORBIDDEN_ROLE rather than that the move is legal.
      assertCanTransition(current, principal, dto.to);
      assertTransition(current.status, dto.to, principal.role);

      const expectedVersion = dto.version ?? current.version;

      const won = await this.rides.transitionWithVersion(
        tx,
        rideId,
        dto.to,
        expectedVersion,
        current.driverId,
        principal.role,
        dto.reason ?? null,
        now,
      );

      if (!won) {
        this.metrics.counter('ride_status_transition_errors').inc({ reason: 'version_conflict' });
        const latest = await this.rides.findById(rideId, tx);
        throw new RideVersionConflictError(rideId, expectedVersion, latest?.version ?? -1);
      }

      const updated = await this.rides.findById(rideId, tx);
      if (!updated) throw new RideNotFoundError(rideId);

      const seq = await this.rides.nextSeq(tx, rideId);
      const eventType = EVENT_FOR_STATUS[dto.to as keyof typeof EVENT_FOR_STATUS];

      await this.events.append({
        tx,
        rideId,
        seq: seq + 1,
        eventType,
        actorId: principal.userId,
        actorRole: principal.role,
        payload: { from: current.status, to: dto.to },
      });

      if (eventType) {
        await this.outbox.enqueue(tx, {
          type: eventType,
          aggregateId: rideId,
          seq: seq + 1,
          correlationId,
          payload: {
            rideId,
            riderId: updated.riderId,
            driverId: updated.driverId,
            from: current.status,
            to: dto.to,
          },
        });
      }

      return updated;
    });

    await this.cache.invalidate(rideId).catch(() => undefined);
    return ride;
  }
}
