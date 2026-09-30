import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { servesHttp } from '../config/app-role';
import { RideExpiryScheduler } from './application/ride-expiry.scheduler';

/**
 * §4.11 — the interval timer for the expiry sweep.
 *
 * Split from `RideExpiryScheduler` on purpose. The sweep is domain logic and
 * belongs with the ride use-cases; *when* it runs is a deployment concern. Having
 * one class own both means the interval is a constructor argument to the logic,
 * and the only way to test a sweep without waiting a minute is to reach past it.
 */
@Injectable()
export class RideExpiryTimer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RideExpiryTimer.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly expiry: RideExpiryScheduler,
  ) {}

  onModuleInit(): void {
    // API-only, and the placement is not a matter of taste.
    //
    // Cancelling a stale ride is a ride *write*, so §3.2 puts it on the API side
    // of the split — and the module graph already says so: `WorkerModule` does
    // not import `RidesModule`, which is why this timer is declared there and
    // cannot fire in a worker at all. An earlier version of this file gated on
    // `runsWorker()` on the assumption that background triggers belong to the
    // background role; that was wrong, and the consequence was a timer that
    // started in the API and silently did nothing in the worker.
    //
    // Which is also why `sweepIfLeader`'s distributed lock is load-bearing rather
    // than belt-and-braces: the API is the horizontally scaled tier, so every
    // replica runs this timer on the same schedule and contends for the same
    // rides. Putting the trigger in the single worker would have made the lock
    // decorative.
    const cfg = this.config.get<AppConfig>(APP_CONFIG)!;
    if (!servesHttp(cfg.APP_ROLE)) return;

    const intervalMs = cfg.RIDE_EXPIRY_SWEEP_INTERVAL_MS;
    // First sweep delayed by one interval rather than run immediately: at boot
    // every replica would sweep at once, and with N replicas starting together
    // that is a thundering herd against the same table for no benefit.
    this.timer = setInterval(() => {
      void this.expiry.sweepIfLeader().catch((err: unknown) => {
        this.logger.warn('ride_expiry.sweep_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);

    this.logger.log('ride_expiry.timer_started', { intervalMs });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}