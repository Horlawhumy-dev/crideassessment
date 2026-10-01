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

/** The interval trigger, split from `RideExpiryScheduler` because *when* the sweep runs is a
 *  deployment concern, not domain logic — otherwise the interval is a constructor argument
 *  to the logic and a sweep can only be tested by waiting. */
@Injectable()
export class RideExpiryTimer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RideExpiryTimer.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly expiry: RideExpiryScheduler,
  ) {}

  onModuleInit(): void {
    // API tier only: cancelling a stale ride is a ride write, and the API is the
    // horizontally scaled side, so every replica runs this timer — which is why
    // `sweepIfLeader` needs the distributed lock.
    const cfg = this.config.get<AppConfig>(APP_CONFIG)!;
    if (!servesHttp(cfg.APP_ROLE)) return;

    const intervalMs = cfg.RIDE_EXPIRY_SWEEP_INTERVAL_MS;
    // First sweep delayed by one interval: at boot N replicas starting together
    // would otherwise sweep the same table at once.
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