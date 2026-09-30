import type { Ride } from '../../domain/ride';

export const RIDE_CACHE_PORT = Symbol('RIDE_CACHE_PORT');

/** The read path must authorize *before* consulting the cache. */
export interface RideCachePort {
  get(rideId: string): Promise<Ride | null>;
  /** Optional so the adapter applies its configured default; callers must not hardcode a TTL. */
  set(ride: Ride, ttlSeconds?: number): Promise<void>;
  invalidate(rideId: string): Promise<void>;
  invalidateRider(riderId: string): Promise<void>;
}

export const RIDE_CACHE_KEYS = {
  detail: (rideId: string) => `ride:${rideId}:v1`,
  riderActive: (riderId: string) => `rider:${riderId}:active:v1`,
  lock: (rideId: string) => `lock:ride:${rideId}`,
} as const;
