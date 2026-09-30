import { EgressGuard } from './egress-guard';
import { RedisClient } from '../cache/redis.client';

/** Models only what the guard relies on: an atomic `SET key val PX ttl NX`. A fake that
 * resolved the winner and the loser the same way would pass the guard while defeating it. */
class FakeRedis {
  keys = new Map<string, string>();
  calls: unknown[][] = [];
  failNext = false;

  set = async (...args: unknown[]): Promise<string | null> => {
    this.calls.push(args);
    if (this.failNext) throw new Error('connection reset');
    const [key, , , , nx] = args as [string, string, string, number, string];
    if (nx === 'NX' && this.keys.has(key)) return null;
    this.keys.set(key, '1');
    return 'OK';
  };
}

const guardWith = (redis: FakeRedis) =>
  new EgressGuard({ client: redis } as unknown as RedisClient);

describe('EgressGuard', () => {
  it('lets exactly one of many instances claim the same event', async () => {
    const redis = new FakeRedis();
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => guardWith(redis).claimOnce('evt|42|ride:status_changed')),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('emits each distinct event exactly once', async () => {
    const redis = new FakeRedis();
    const guard = guardWith(redis);

    expect(await guard.claimOnce('evt|1|x')).toBe(true);
    expect(await guard.claimOnce('evt|2|x')).toBe(true);
    expect(await guard.claimOnce('evt|1|x')).toBe(false);
  });

  it('claims with a short NX TTL so an outbox retry is not suppressed forever', async () => {
    const redis = new FakeRedis();
    await guardWith(redis).claimOnce('evt|9|x');

    const [key, value, px, ttl, nx] = redis.calls[0] as [string, string, string, number, string];
    expect(key).toBe('egress:claim:evt|9|x');
    expect(value).toBe('1');
    expect(px).toBe('PX');
    expect(nx).toBe('NX');
    // The claim only has to outlast the pub/sub fan-out; a long TTL would start eating
    // the relay's retries, which re-drive the same event id.
    expect(ttl).toBeLessThanOrEqual(10_000);
  });

  it('fails open when Redis is unreachable, so a claim error cannot silence an event', async () => {
    const redis = new FakeRedis();
    redis.failNext = true;

    await expect(guardWith(redis).claimOnce('evt|err|x')).resolves.toBe(true);
  });
});
