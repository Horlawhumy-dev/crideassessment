import type { GeoPoint } from '../kernel/geo-point';

export const LOCATION_STORE = Symbol('LOCATION_STORE');

export interface DriverLocation {
  readonly driverId: string;
  readonly position: GeoPoint;
  readonly heading: number | null;
  readonly speedKph: number | null;
  readonly accuracyM: number | null;
  readonly recordedAt: Date;
}

/** Separate from rides: per-second writes, ~60 s retention, loss tolerance. Nothing here writes PostgreSQL. */
export interface LocationStore {
  put(rideId: string, location: DriverLocation, ttlSeconds: number): Promise<void>;
  get(rideId: string): Promise<DriverLocation | null>;
  publish(rideId: string, location: DriverLocation): Promise<void>;
  subscribe(handler: (rideId: string, location: DriverLocation) => void): () => void;

  /**
   * An atomic single-holder claim valid for `ttlMs`: true for the first caller in the
   * window. Redis SET NX is the correct implementation — a process-local Map fails as
   * soon as there is a second API instance.
   */
  claim(key: string, ttlMs: number): Promise<boolean>;
}
