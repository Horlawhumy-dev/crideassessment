import type { Money } from '../../kernel/money';
import type { GeoPoint } from '../../kernel/geo-point';
import {
  assertTransition,
  isActive,
  isTerminal,
  type RideActor,
  type RideStatus,
} from './ride-status';

/** The ride aggregate. Pure: every invariant is a function of its own fields. */
export interface Ride {
  readonly id: string;
  readonly riderId: string;
  readonly driverId: string | null;
  readonly status: RideStatus;
  /** Optimistic concurrency token for the generic transition path. */
  readonly version: number;
  readonly pickup: GeoPoint;
  readonly dropoff: GeoPoint;
  readonly pickupAddress: string | null;
  readonly dropoffAddress: string | null;
  readonly fare: Money | null;
  readonly cancelledBy: RideActor | null;
  readonly cancelReason: string | null;
  readonly acceptedAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One audit-trail entry; `seq` is per-ride and monotonic. */
export interface RideEvent {
  readonly id: string;
  readonly rideId: string;
  readonly seq: number;
  readonly eventType: string;
  readonly actorId: string | null;
  readonly actorRole: RideActor | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

export function isParticipant(ride: Ride, userId: string): boolean {
  return ride.riderId === userId || ride.driverId === userId;
}

export function isRider(ride: Ride, userId: string): boolean {
  return ride.riderId === userId;
}

export function isAssignedDriver(ride: Ride, userId: string): boolean {
  return ride.driverId === userId;
}

export function hasActiveRide(rides: readonly Ride[]): Ride | undefined {
  return rides.find((r) => isActive(r.status));
}

/** The only writer of `status` in the domain layer: it enforces the legal edges, the actor
 *  matrix, and that an `ACCEPTED` ride has no driver yet. Returns a new Ride. */
export function transition(
  ride: Ride,
  to: RideStatus,
  actor: RideActor,
  now: Date = new Date(),
): Ride {
  assertTransition(ride.status, to, actor);

  if (to === 'ACCEPTED' && ride.driverId !== null) {
    throw new Error('cannot accept a ride that already has a driver');
  }

  // `-readonly` because `Partial<Ride>` keeps the interface's readonly modifiers
  // and so cannot be written to. The patch is local and discarded here.
  const patch: {
    -readonly [K in keyof Ride]?: Ride[K];
  } = {
    status: to,
    version: ride.version + 1,
    updatedAt: now,
  };

  if (to === 'ACCEPTED') patch.acceptedAt = now;
  if (to === 'IN_PROGRESS') patch.startedAt = now;
  if (to === 'COMPLETED') patch.completedAt = now;
  if (to === 'CANCELLED') patch.cancelledBy = actor;

  return { ...ride, ...patch };
}

/** Assigns the driver as part of the accept transition, atomically in the domain. */
export function assignDriver(ride: Ride, driverId: string, now: Date = new Date()): Ride {
  const accepted = transition(ride, 'ACCEPTED', 'DRIVER', now);
  return { ...accepted, driverId };
}

export function canBeCancelled(ride: Ride): boolean {
  return !isTerminal(ride.status);
}

export function durationMs(ride: Ride): number | null {
  if (!ride.completedAt) return null;
  const start = ride.startedAt ?? ride.acceptedAt ?? ride.createdAt;
  return ride.completedAt.getTime() - start.getTime();
}
