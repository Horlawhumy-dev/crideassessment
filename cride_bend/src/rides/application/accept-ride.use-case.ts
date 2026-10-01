import { Inject, Injectable } from '@nestjs/common';
import { DomainError, RideAlreadyAcceptedError, RideNotAcceptableError, RideNotFoundError } from '../../common/errors/domain-error';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../kernel/transaction';
import { MetricsService } from '../../platform/otel/metrics';
import { type Principal } from '../domain/ride-policy';
import type { Ride } from '../domain/ride';
import { RIDE_REPOSITORY, type RideRepository } from './ports/ride.repository';
import { OUTBOX_PORT, type OutboxPort } from './ports/outbox.port';
import { RIDE_EVENTS_PORT, type RideEventsPort } from './ports/ride-events.port';
import { RIDE_CACHE_PORT, type RideCachePort } from './ports/ride-cache.port';

/** `acceptIfRequested` is one atomic conditional statement. A lost race is disambiguated
 *  by reading *after* that write, never before — a read first would leave the window open. */
@Injectable()
export class AcceptRideUseCase {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly rides: RideRepository,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort,
    @Inject(RIDE_EVENTS_PORT) private readonly events: RideEventsPort,
    @Inject(RIDE_CACHE_PORT) private readonly cache: RideCachePort,
    @Inject(TRANSACTION_RUNNER) private readonly tx: TransactionRunner,
    private readonly metrics: MetricsService,
  ) {}

  async execute(principal: Principal, rideId: string, correlationId: string): Promise<Ride> {
    if (principal.role !== 'DRIVER') {
      throw new DomainError('FORBIDDEN_ROLE', 'Only a driver can accept a ride.');
    }

    const now = new Date();

    const ride = await this.tx.run(async (tx) => {
      // The version is needed to build the write predicate, so the row is read first —
      // but that read cannot influence the outcome, only the error message.
      const preflight = await this.rides.findById(rideId, tx);
      if (!preflight) throw new RideNotFoundError(rideId);

      // Guard and write in one statement: the predicate is the WHERE clause.
      const won = await this.rides.acceptIfRequested(
        tx,
        rideId,
        principal.userId,
        preflight.version,
        now,
      );

      if (!won) {
        const current = await this.rides.findById(rideId, tx);
        if (!current) throw new RideNotFoundError(rideId);
        if (current.driverId !== null) {
          this.metrics.counter('ride_accept_conflict_total').inc({ reason: 'already_accepted' });
          throw new RideAlreadyAcceptedError(rideId);
        }
        this.metrics.counter('ride_accept_conflict_total').inc({ reason: 'not_requested' });
        throw new RideNotAcceptableError(rideId, current.status);
      }

      const accepted = await this.rides.findById(rideId, tx);
      if (!accepted) throw new RideNotFoundError(rideId);

      // A post-condition, not a precondition: `assertCanAccept` would now fail on its
      // own successful write. Anything else means the read and the write disagreed.
      if (accepted.status !== 'ACCEPTED' || accepted.driverId !== principal.userId) {
        throw new RideAlreadyAcceptedError(rideId);
      }

      const seq = await this.rides.nextSeq(tx, rideId);

      await this.events.append({
        tx,
        rideId,
        seq: seq + 1,
        eventType: 'ride.accepted',
        actorId: principal.userId,
        actorRole: 'DRIVER',
        payload: { driverId: principal.userId },
      });

      await this.outbox.enqueue(tx, {
        type: 'ride.accepted',
        aggregateId: rideId,
        seq: seq + 1,
        correlationId,
        payload: { rideId, driverId: principal.userId, riderId: accepted.riderId },
      });

      return accepted;
    });

    await Promise.all([
      this.cache.invalidate(rideId).catch(() => undefined),
      this.cache.invalidateRider(ride.riderId).catch(() => undefined),
    ]);

    this.metrics.counter('ride_accepts_total').inc();
    return ride;
  }
}
