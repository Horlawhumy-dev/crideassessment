import type { GeoPoint } from '../kernel/geo-point';

export const ROUTE_BUFFER = Symbol('ROUTE_BUFFER');

/** One recorded position, as buffered during a trip. */
export interface RoutePointSample {
  readonly lat: number;
  readonly lng: number;
  readonly speedKph: number | null;
  readonly headingDeg: number | null;
  readonly recordedAt: Date;
}

/**
 * The durable polyline: live tracking must not write to PostgreSQL, and the latest
 * position alone leaves no trail. So frames accumulate in a capped Redis list while
 * the trip is live and drain to `route_points` once at completion. A polyline is
 * presentation, so losing it to a Redis flush is acceptable; the cap and TTL bound
 * an abandoned ride, and (rideId, seq) being unique makes a partial drain retryable.
 */
export interface RouteBuffer {
  /** Buffered as well as stored live; never allowed to fail the frame. */
  append(rideId: string, sample: RoutePointSample): Promise<void>;

  /**
   * Atomic on purpose: a non-atomic LRANGE-then-DEL would let a retry double-write, or
   * drop points written between the two commands.
   */
  drain(rideId: string): Promise<readonly RoutePointSample[]>;

  /** Points buffered so far, for tests and for the completion response. */
  size(rideId: string): Promise<number>;
}

export type { GeoPoint };