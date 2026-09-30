import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../otel/metrics';
import { RedisClient } from './redis.client';

/** Every Redis call is wrapped with a timeout and a circuit breaker, so a Redis outage
 * degrades to a cache miss instead of making Redis a hard dependency of the request path. */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private failures = 0;
  private openedAt: number | null = null;

  // Five consecutive failures trip the breaker. Consecutive rather than a rate over a
  // window: a cache that fails intermittently is still serving, and tripping on it
  // would turn a degraded cache into an absent one.
  private static readonly FAILURE_THRESHOLD = 5;
  private static readonly HALF_OPEN_AFTER_MS = 15_000;
  private static readonly COMMAND_TIMEOUT_MS = 250;

  constructor(
    private readonly redis: RedisClient,
    private readonly metrics: MetricsService,
  ) {}

  get degraded(): boolean {
    return this.openedAt !== null;
  }

  /**
   * Symmetric with `set`, which JSON-stringifies on the way in, so the `<T>` is honest.
   * A parse failure is a miss rather than an error: a malformed entry is unusable, and
   * the contract here is that Redis never fails a request.
   */
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.exec('get', () => this.redis.client.get(key), null);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn('cache.unparseable', { key });
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.exec('set', () =>
      this.redis.client.set(key, JSON.stringify(value), 'EX', ttlSeconds), undefined);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.exec('del', () => this.redis.client.del(...keys), 0);
  }

  async delByPattern(pattern: string): Promise<void> {
    // SCAN, never KEYS: KEYS blocks the server for the whole keyspace.
    await this.exec('scan-del', async () => {
      let cursor = '0';
      do {
        const [next, found] = await this.redis.client.scan(
          cursor, 'MATCH', pattern, 'COUNT', 100,
        );
        cursor = next;
        if (found.length > 0) await this.redis.client.del(...found);
      } while (cursor !== '0');
    }, undefined);
  }

  /** Stampede protection: only the lock winner reaches the database. */
  async acquireLock(key: string, ttlMs: number, token: string): Promise<boolean> {
    const res = await this.exec(
      'lock',
      () => this.redis.client.set(key, token, 'PX', ttlMs, 'NX'),
      null,
    );
    return res === 'OK';
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.exec('unlock', () =>
      this.redis.client.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        key,
        token,
      ), undefined);
  }

  private async exec<T>(op: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    if (this.degraded) {
      if (Date.now() - (this.openedAt ?? 0) < CacheService.HALF_OPEN_AFTER_MS) {
        return fallback;
      }
      this.openedAt = null; // half-open: let one call through
    }

    try {
      const result = await withTimeout(fn(), CacheService.COMMAND_TIMEOUT_MS);
      this.failures = 0;
      return result;
    } catch {
      this.failures += 1;
      this.metrics.counter('cache_operation_failed_total').inc({ op });

      if (this.failures >= CacheService.FAILURE_THRESHOLD) {
        this.openedAt = Date.now();
        this.logger.warn('cache.circuit_open', { op });
        this.metrics.gauge('cache_degraded').set(1);
      }

      return fallback;
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('cache timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
