import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { MetricsService } from '../../platform/otel/metrics';
import { RedisClient } from '../../platform/cache/redis.client';
import { RIDE_REPOSITORY, type RideRepository } from './ports/ride.repository';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../../kernel/transaction';
import { OUTBOX_PORT, type OutboxPort } from './ports/outbox.port';
import { RIDE_EVENTS_PORT, type RideEventsPort } from './ports/ride-events.port';
import { assertSystemExpiry } from '../domain/ride-status';

/** Auto-cancel stale REQUESTED rides under a Redis lock, over the same ports the HTTP
 *  path uses. Not `TransitionRideUseCase`: it opens with `assertCanView`, and a SYSTEM
 *  expiry has no principal. The lock matters because every API replica runs the timer. */
@Injectable()
export class RideExpiryScheduler {
  private readonly logger = new Logger(RideExpiryScheduler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(RIDE_REPOSITORY) private readonly rides: RideRepository,
    @Inject(TRANSACTION_RUNNER) private readonly tx: TransactionRunner,
    @Inject(OUTBOX_PORT) private readonly outbox: OutboxPort,
    @Inject(RIDE_EVENTS_PORT) private readonly events: RideEventsPort,
    @Inject(RedisClient) private readonly redis: RedisClient,
    private readonly metrics: MetricsService,
  ) {}

  /** One sweep; returns the number of rides cancelled. */
  async sweep(): Promise<number> {
    const cfg = this.config.get<AppConfig>(APP_CONFIG)!;
    const ttlMinutes = cfg.RIDE_OFFER_TTL_MINUTES;
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000);

    // Only REQUESTED rides can expire: ACCEPTED and IN_PROGRESS have a driver
    // entitled to finish the trip.
    const stale = await this.prisma.ride.findMany({
      where: { status: 'REQUESTED', createdAt: { lt: cutoff } },
      select: { id: true, version: true, riderId: true, driverId: true, status: true },
      take: 100,
    });

    if (stale.length === 0) return 0;

    let cancelled = 0;
    for (const ride of stale) {
      try {
        const ok = await this.expireOne(ride.id, cutoff);
        if (ok) cancelled += 1;
      } catch (err) {
        // One bad ride must not abort the batch; the rest are independent.
        this.logger.warn('ride_expiry.cancel_failed', {
          rideId: ride.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.metrics.counter('ride_expiry_swept_total').inc({ cancelled: String(cancelled) });
    this.logger.log('ride_expiry.swept', { considered: stale.length, cancelled });
    return cancelled;
  }

  /** One sweep under the lock. Losing the lock is not an error: a peer is already
   *  doing this exact work. */
  async sweepIfLeader(lockTtlSeconds = 30): Promise<number> {
    const key = 'ride-expiry:sweep-lock';

    // One atomic command; a GET-then-SET would let two replicas both see absence.
    // The value is the pid so the release can prove it is deleting its own lock.
    const acquired = await this.redis.client.set(key, String(process.pid), 'EX', lockTtlSeconds, 'NX');
    if (acquired !== 'OK') {
      this.logger.debug('ride_expiry.lock_held_elsewhere');
      return 0;
    }

    try {
      return await this.sweep();
    } finally {
      // Release only if we still hold it: a DEL from a process whose lock already
      // expired would delete a peer's lock and let two sweeps run.
      await this.redis.client
        .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, String(process.pid))
        .catch(() => undefined);
    }
  }

  /** @internal exposed for the interval timer and for tests */
  async expireOne(rideId: string, cutoff: Date): Promise<boolean> {
    const now = new Date();

    const cancelled = await this.tx.run(async (tx) => {
      // Re-read under the transaction and re-check the cutoff: the scan ran outside
      // it, so a driver may have accepted in between. Only the id is carried in;
      // status, version and createdAt all come from this read.
      const current = await this.rides.findById(rideId, tx);
      if (!current) return null;
      if (current.status !== 'REQUESTED') return null;
      if (current.createdAt >= cutoff) return null;

      // The system rule, not the principal one: `assertTransition(..., 'RIDER')`
      // would stamp `cancelledBy: RIDER` on a ride nobody pressed anything on.
      assertSystemExpiry(current.status, 'CANCELLED');

      const won = await this.rides.transitionWithVersion(
        tx,
        current.id,
        'CANCELLED',
        current.version,
        current.driverId,
        'SYSTEM',
        'No driver accepted within the offer window',
        now,
      );
      if (!won) return null;

      const updated = await this.rides.findById(current.id, tx);
      const seq = await this.rides.nextSeq(tx, current.id);

      await this.events.append({
        tx,
        rideId: current.id,
        seq: seq + 1,
        eventType: 'ride.cancelled',
        // SYSTEM, not RIDER: nobody pressed anything, and a client must be able to
        // tell an expiry from a user cancellation.
        actorId: null,
        actorRole: 'SYSTEM',
        payload: { from: current.status, to: 'CANCELLED', reason: 'expired' },
      });

      await this.outbox.enqueue(tx, {
        type: 'ride.cancelled',
        aggregateId: current.id,
        seq: seq + 1,
        correlationId: 'ride-expiry',
        payload: {
          rideId: current.id,
          riderId: updated?.riderId ?? current.riderId,
          driverId: null,
          from: current.status,
          to: 'CANCELLED',
          reason: 'expired',
        },
      });

      return updated ?? current;
    });

    if (!cancelled) return false;

    // The `ride.cancelled` outbox row above is already what the relay turns into a
    // notification; enqueueing again would notify twice.
    return true;
  }

  /** Cancel immediately, for a test or an operator action. */
  async expireNow(rideId: string): Promise<boolean> {
    const ride = await this.rides.findById(rideId);
    if (!ride) return false;
    const cutoff = new Date(Date.now() + 1);
    return this.expireOne(rideId, cutoff);
  }
}