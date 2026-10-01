import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';

@Injectable()
export class RedisClient implements OnModuleDestroy {
  private readonly logger = new Logger(RedisClient.name);
  readonly client: Redis;
  private readonly options: RedisOptions;

  constructor(config: ConfigService) {
    const { REDIS_URL } = config.get<AppConfig>(APP_CONFIG)!;

    this.options = {
      // Without an explicit connect timeout a Redis blip becomes an API outage, because
      // every cache call awaits an unbounded handshake.
      connectTimeout: 2_000,
      commandTimeout: 1_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    };

    this.client = new Redis(REDIS_URL, this.options);
    this.client.on('error', (err) => this.logger.warn('redis.error', { err: err.message }));
  }

  /**
   * A subscriber issues its `SUBSCRIBE`/`PSUBSCRIBE` during startup, before the handshake
   * has completed, and with the offline queue disabled ioredis rejects it outright ("Stream
   * isn't writeable and enableOfflineQueue options is false"). Right for a request/response
   * connection, wrong for a subscriber whose only ever command is the subscription — and a
   * retry cannot recover it. So buffer it.
   */
  duplicateForPubSub(): Redis {
    return this.client.duplicate({ ...this.options, enableOfflineQueue: true });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
