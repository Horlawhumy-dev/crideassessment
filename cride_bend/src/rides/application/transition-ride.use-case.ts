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

/**
 * §4.5.2c — the generic transition path, guarded by `version`.
 *
 * This use-case is also what the socket's `ride:transition` handler calls,
 * unchanged (§4.8.2). The socket is a transport; the use-case is the system. That
 * is why there is exactly one way a ride state can change.
 */
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

      // The order of these four checks is the whole contract, and each position is
      // load-bearing. Moving any of them changes which error a client sees, which
      // is not cosmetic: the four answer four different questions.
      //
      // 1. Visibility, first and always. 404 rather than 403 because a 403 confirms
      //    the ride exists. Everything below this line may therefore describe the
      //    ride's status and version without leaking anything to a stranger.
      assertCanView(current, principal);

      // 2. Terminality, before any actor policy. A terminal ride admits no
      //    transition from *anyone*, so asking the actor policy first would answer
      //    a question about permissions for a ride that is simply over — and
      //    `assertCanTransition` routes `to: ACCEPTED` into the accept path, which
      //    would report RIDE_ALREADY_ACCEPTED for a ride that finished an hour ago.
      if (isTerminal(current.status)) {
        throw new InvalidTransitionError(current.status, dto.to);
      }

      // 3. The version guard, before the state table — and this ordering is what
      //    makes optimistic concurrency mean anything. Under READ COMMITTED the
      //    read above can observe a *competitor's committed* transition: two
      //    clients both holding version 2 ask for IN_PROGRESS, one wins, and the
      //    loser's pre-read then sees IN_PROGRESS and reports INVALID_TRANSITION.
      //    That is the wrong answer to give a client — it tells the caller to stop
      //    retrying when the correct response is to refetch. Comparing the
      //    client-supplied version first makes the outcome deterministic:
      //    whoever reads a bumped version is a stale caller, whoever loses the
      //    conditional UPDATE below is also a stale caller, and both get the same
      //    code. Only checked when a version was supplied; omitting it is the
      //    documented last-writer-wins convenience path.
      if (dto.version !== undefined && dto.version !== current.version) {
        this.metrics.counter('ride_status_transition_errors').inc({ reason: 'version_conflict' });
        throw new RideVersionConflictError(rideId, dto.version, current.version);
      }

      // 4. Authorization and legality as pure functions, before any write. The
      //    actor policy runs before the table so that a rider attempting to drive a
      //    ride forward is told FORBIDDEN_ROLE rather than being told the move is
      //    legal and then failing the permission check.
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
