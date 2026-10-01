import { Injectable, Logger } from '@nestjs/common';
import { RedisClient } from '../cache/redis.client';

/** Elects one emitter across replicas: the Socket.IO adapter fans every `emit` back out to
 * all nodes, so without an election the rider's socket collects one copy per instance. */
@Injectable()
export class EgressGuard {
  private readonly logger = new Logger(EgressGuard.name);

  // Outlasts the sub-second pub/sub fan-out only. A longer TTL eats the relay's retries,
  // which re-drive the same event id.
  private static readonly TTL_MS = 3_000;

  constructor(private readonly redis: RedisClient) {}

  /**
   * @param key `eventId|event|audience|audienceId`. `event` and `audience` are load-bearing:
   *   one committed event publishes several distinct messages — `ride.accepted` emits both
   *   `ride:status_changed` and `ride:assigned` — which are different things, not duplicates.
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
      // Fails open: unreachable Redis means this instance never received the event anyway.
      this.logger.warn('egress.claim_failed', {
        key,
        err: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }
}
