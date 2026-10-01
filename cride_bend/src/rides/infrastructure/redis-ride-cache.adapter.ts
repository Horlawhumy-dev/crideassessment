import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { CacheService } from '../../platform/cache/cache.service';
import type { Ride } from '../domain/ride';
import { RIDE_CACHE_KEYS, type RideCachePort } from '../application/ports/ride-cache.port';

/** Cache is never the source of truth, and a cache failure is never a request failure: every
 *  write is also covered by the configured TTL. */
@Injectable()
export class RedisRideCacheAdapter implements RideCachePort {
  constructor(
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  private get ttl(): number {
    return this.config.get<AppConfig>(APP_CONFIG)!.RIDE_CACHE_TTL_SECONDS;
  }

  /** `revive` on the way out: without it a hit returns `createdAt` and `fare.amountMinor`
   *  as strings while a miss returns Dates and bigints, and only `toResponse` on the hit
   *  path throws. */
  async get(rideId: string): Promise<Ride | null> {
    const cached = await this.cache.get<unknown>(RIDE_CACHE_KEYS.detail(rideId));
    return cached ? revive(cached as Ride) : null;
  }

  async set(ride: Ride, ttlSeconds?: number): Promise<void> {
    await this.cache.set(RIDE_CACHE_KEYS.detail(ride.id), dehydrate(ride), ttlSeconds ?? this.ttl);
  }

  async invalidate(rideId: string): Promise<void> {
    await this.cache.del(RIDE_CACHE_KEYS.detail(rideId));
  }

  async invalidateRider(riderId: string): Promise<void> {
    await this.cache.del(RIDE_CACHE_KEYS.riderActive(riderId));
  }
}

/** JSON turns Date and bigint into strings, so both must be restored on read. */
function revive(raw: Ride): Ride {
  const d = (v: string | Date | null | undefined): Date | null =>
    v === null || v === undefined ? null : new Date(v);

  return {
    ...raw,
    acceptedAt: d(raw.acceptedAt),
    startedAt: d(raw.startedAt),
    completedAt: d(raw.completedAt),
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    fare:
      raw.fare === null || raw.fare === undefined
        ? null
        : {
            amountMinor: BigInt(
              typeof raw.fare.amountMinor === 'string'
                ? raw.fare.amountMinor
                : String(raw.fare.amountMinor),
            ),
            currency: raw.fare.currency,
          },
  };
}

/** The inverse of `revive`. `set` must dehydrate, never revive: a BigInt reaching
 *  `JSON.stringify` throws and `CacheService.exec` swallows it into a silent miss. */
function dehydrate(ride: Ride): unknown {
  const d = (v: Date | null): string | null => (v === null || v === undefined ? null : v.toISOString());

  return {
    ...ride,
    acceptedAt: d(ride.acceptedAt),
    startedAt: d(ride.startedAt),
    completedAt: d(ride.completedAt),
    createdAt: ride.createdAt.toISOString(),
    updatedAt: ride.updatedAt.toISOString(),
    fare:
      ride.fare === null || ride.fare === undefined
        ? null
        : { amountMinor: String(ride.fare.amountMinor), currency: ride.fare.currency },
  };
}
