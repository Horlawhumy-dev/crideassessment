import type { ConfigService } from '@nestjs/config';
import { loadConfig } from '../../config/env.schema';
import type { CacheService } from '../../platform/cache/cache.service';
import { RedisRideCacheAdapter } from './redis-ride-cache.adapter';
import { RIDE_CACHE_KEYS, type RideCachePort } from '../application/ports/ride-cache.port';
import type { Ride } from '../domain/ride';

/**
 * Round-trip against a fake that JSON-serialises like the real `CacheService`; a
 * stub holding object references would never exercise the wire form.
 */
describe('RedisRideCacheAdapter', () => {
  /** Mimics CacheService: JSON on write, JSON.parse on read. Swallows nothing. */
  class FakeCache {
    readonly store = new Map<string, string>();
    readonly ttls: number[] = [];

    async get<T>(key: string): Promise<T | null> {
      const raw = this.store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    }

    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      this.store.set(key, JSON.stringify(value));
      this.ttls.push(ttlSeconds);
    }

    async del(...keys: string[]): Promise<void> {
      for (const k of keys) this.store.delete(k);
    }
  }

  function makeRide(over: Partial<Ride> = {}): Ride {
    return {
      id: 'ride-1',
      riderId: 'rider-1',
      driverId: null,
      status: 'REQUESTED',
      version: 1,
      pickup: { lat: 7.1, lng: 4.1 },
      dropoff: { lat: 7.2, lng: 4.2 },
      pickupAddress: null,
      dropoffAddress: null,
      // BigInt on purpose: this is the field that made JSON.stringify throw.
      fare: { amountMinor: BigInt(9100), currency: 'NGN' },
      acceptedAt: null,
      startedAt: null,
      completedAt: null,
      completedAtReason: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...over,
    } as Ride;
  }

  // `loadConfig`, not a stub, so the TTL assertion is about the real default. The
  // URLs are supplied only because the schema requires them.
  function build(cache: FakeCache): RideCachePort {
    const cfg = loadConfig({
      DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
      REDIS_URL: 'redis://localhost:6379',
    });
    const config = { get: () => cfg } as unknown as ConfigService;
    return new RedisRideCacheAdapter(cache as unknown as CacheService, config);
  }

  it('writes a value that survives the JSON round-trip', async () => {
    const cache = new FakeCache();
    const adapter = build(cache);

    await expect(adapter.set(makeRide())).resolves.toBeUndefined();
    expect(cache.store.get(RIDE_CACHE_KEYS.detail('ride-1'))).toBeDefined();
  });

  it('reads back BigInt, Date and null exactly as they went in', async () => {
    const cache = new FakeCache();
    const adapter = build(cache);
    const original = makeRide({
      status: 'ACCEPTED',
      driverId: 'driver-1',
      version: 2,
      acceptedAt: new Date('2026-01-02T03:04:05.000Z'),
    });

    await adapter.set(original);
    const back = await adapter.get('ride-1');

    expect(back).not.toBeNull();
    // A string here would 500 at `toResponse` on the cache-hit path only.
    expect(back!.fare!.amountMinor).toBe(BigInt(9100));
    expect(back!.createdAt).toBeInstanceOf(Date);
    expect(back!.acceptedAt).toBeInstanceOf(Date);
    expect(back!.startedAt).toBeNull();
    expect(back!.version).toBe(2);
  });

  it('uses the configured TTL rather than a literal baked into the caller', async () => {
    const cache = new FakeCache();
    const adapter = build(cache);
    await adapter.set(makeRide());
    // RIDE_CACHE_TTL_SECONDS defaults to 30; the adapter must supply it, not the caller.
    expect(cache.ttls).toEqual([30]);
  });

  it('honours an explicit TTL override', async () => {
    const cache = new FakeCache();
    const adapter = build(cache);
    await adapter.set(makeRide(), 5);
    expect(cache.ttls).toEqual([5]);
  });

  it('returns null for a cold key instead of throwing', async () => {
    const cache = new FakeCache();
    const adapter = build(cache);
    expect(await adapter.get('never-written')).toBeNull();
  });

  it('deletes the detail key on invalidate', async () => {
    const cache = new FakeCache();
    const adapter = build(cache);
    await adapter.set(makeRide());
    await adapter.invalidate('ride-1');
    expect(await adapter.get('ride-1')).toBeNull();
  });

  it('deletes the rider key on invalidateRider', async () => {
    const cache = new FakeCache();
    const adapter = build(cache);
    cache.store.set(RIDE_CACHE_KEYS.riderActive('rider-1'), '{}');
    await adapter.invalidateRider('rider-1');
    expect(cache.store.has(RIDE_CACHE_KEYS.riderActive('rider-1'))).toBe(false);
  });
});
