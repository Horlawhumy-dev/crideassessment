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

/**
 * §4.11 — auto-cancel rides nobody took, guarded by a distributed lock.
 *
 * Three decisions here are deliberate, and each is a place where the obvious
 * implementation is wrong:
 *
 * 1. **It goes through the same ports an HTTP transition goes through**, rather
 *    than issuing an UPDATE of its own. §9's claim that ride state is only written
 *    by the use-cases is only true if this does not open a side door. A bespoke
 *    `prisma.ride.update({status: CANCELLED})` here would skip the version guard,
 *    skip the RideEvent append that makes socket resync work, and skip the outbox
 *    write that tells the rider their ride died.
 *
 *    It does *not* call `TransitionRideUseCase` itself, and that is the one
 *    deviation worth flagging. That use-case's first act is `assertCanView(ride,
 *    principal)`, and a SYSTEM expiry has no user to be a party to the ride — so
 *    driving it would mean fabricating a rider principal and letting the audit
 *    trail record a cancellation the rider never made. The shared write sequence
 *    is reproduced here over the same `TransactionRunner` and
 *    `RideRepository` ports instead. The cost is real: if the HTTP path ever grows
 *    a step, this will not pick it up automatically. The alternative — a
 *    `TransitionRideUseCase.executeSystem` overload that short-circuits visibility
 *    — is worse, because it puts a bypass inside the guard everyone else uses.
 *
 * 2. **The lock is Redis SET NX, and it is required, not defensive.** The sweep is
 *    triggered by an interval timer in the API tier — the side that owns ride
 *    writes, and the side that scales horizontally. So with N replicas every
 *    replica runs this on the same schedule and races for the same ride. The
 *    conditional UPDATE inside the transaction would still mean only one *wins* —
 *    but all N would do the work, log a version conflict, and burn a retry, and
 *    the log would be unreadable. A process-local flag would be worse than
 *    nothing: it would be correct on one replica and silently wrong on two, which
 *    is the failure mode that only appears in production.
 *
 * 3. **The lock is released in a `finally`.** A sweep that throws while holding
 *    it would otherwise wedge the whole feature until the TTL expired, and the
 *    failure would present as "expiry silently stopped working" rather than as an
 *    error.
 */
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

  /**
   * One sweep. Returns the number of rides cancelled, so tests and the interval
   * caller both have something to assert on.
   */
  async sweep(): Promise<number> {
    const cfg = this.config.get<AppConfig>(APP_CONFIG)!;
    const ttlMinutes = cfg.RIDE_OFFER_TTL_MINUTES;
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000);

    // Only REQUESTED rides can expire. An ACCEPTED or IN_PROGRESS ride has a
    // driver who is entitled to finish the trip, so the sweep must not touch it.
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
        // One bad ride must not abort the sweep. The rest of the batch is
        // independent, and an expiry feature that stops working because a single
        // row was malformed is worse than one that is merely slow.
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

  /**
   * Runs one sweep under the distributed lock, and is what the interval timer and
   * the test both call. A caller that loses the lock is not an error: another
   * replica is already doing this exact work.
   */
  async sweepIfLeader(lockTtlSeconds = 30): Promise<number> {
    const key = 'ride-expiry:sweep-lock';

    // SET key <pid> NX EX ttl — a single atomic command. `claim` on the location
    // store is the same primitive for the same reason; a GET-then-SET would let
    // two replicas both observe absence. The value is the pid so the release
    // below can prove it is deleting its own lock and not a peer's.
    const acquired = await this.redis.client.set(key, String(process.pid), 'EX', lockTtlSeconds, 'NX');
    if (acquired !== 'OK') {
      this.logger.debug('ride_expiry.lock_held_elsewhere');
      return 0;
    }

    try {
      return await this.sweep();
    } finally {
      // Release only if we still hold it. A DEL from a process whose lock already
      // expired would delete a *different* instance's lock and let two sweeps run.
      await this.redis.client
        .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, String(process.pid))
        .catch(() => undefined);
    }
  }

  /** @internal exposed for the interval timer and for tests */
  async expireOne(rideId: string, cutoff: Date): Promise<boolean> {
    const now = new Date();

    const cancelled = await this.tx.run(async (tx) => {
      // Re-read under the transaction, and re-check the cutoff here. The sweep's
      // findMany ran outside it, so by the time we get here a driver may have
      // accepted the ride — and the row we are about to write would then cancel a
      // trip that is already under way. Only the id is carried in from the scan;
      // status, version and createdAt all come from this read, never from the
      // projection the scan happened to select.
      const current = await this.rides.findById(rideId, tx);
      if (!current) return null;
      if (current.status !== 'REQUESTED') return null;
      if (current.createdAt >= cutoff) return null;

      // The system rule, not the principal one. `assertTransition(..., 'RIDER')`
      // would pass today and quietly lie: it would authorise a write on the
      // grounds that a rider asked for it, and `cancelledBy` would be stamped
      // RIDER on a ride nobody pressed anything on. `assertSystemExpiry` is the
      // honest check, and it is also the one that refuses to cancel a ride that
      // already has a driver.
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
        // SYSTEM, not RIDER: nobody pressed anything. A client reading this back
        // needs to be able to tell an expiry from a user cancellation.
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

    // No explicit enqueue here, and that is intentional rather than an omission.
    // The `ride.cancelled` outbox row written above is already what the relay
    // turns into a notification job, so pushing directly from this class would
    // produce two notifications for one expiry — and it would also mean the
    // notification for the *only* path that cancels a ride nobody is watching had
    // weaker delivery guarantees than every other notification.
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