import { Injectable, Logger } from '@nestjs/common';
import { RedisClient } from '../cache/redis.client';

/**
 * `claimOnce` elects one emitter across replicas: every instance receives the event and
 * the Redis adapter fans any `emit` back out to all nodes, so without an election the
 * rider's socket collects one copy per instance.
 *
 * The 3s TTL only has to outlast that sub-second fan-out. A longer one starts eating the
 * relay's retries, which re-drive the same event id. A claim failure fails *open*: Redis
 * being unreachable means the event never arrived here anyway.
 */
@Injectable()
export class EgressGuard {
  private readonly logger = new Logger(EgressGuard.name);

  private static readonly TTL_MS = 3_000;

  constructor(private readonly redis: RedisClient) {}

  /**
   * @param key `eventId|event|audience|audienceId`. `event` and `audience` are load-bearing
   *   parts: one committed event publishes several distinct messages (`ride.accepted` emits both
   *   `ride:status_changed` and `ride:assigned`), and those are different things, not duplicates.
   * @returns true if this instance is the one that should emit.
   */
  async claimOnce(key: string): Promise<boolean> {
    try {
      const res = await this.redis.client.set(
        `egress:claim:${key}`,
        '1',
        'PX',
        EgressGuard.TTL_MS,
        'NX',
      );
      return res === 'OK';
    } catch (err: unknown) {
      this.logger.warn('egress.claim_failed', {
        key,
        err: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }
}
