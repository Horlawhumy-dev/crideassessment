import { RideNotVisibleError, ForbiddenRoleError, RideAlreadyAcceptedError, RideNotAcceptableError, NotAssignedDriverError } from '../../common/errors/domain-error';
import type { Ride } from './ride';
import { InvalidTransitionError, type RideStatus } from './ride-status';

/** Resource-scoped authorization as pure domain logic. A role gate answers "may a driver
 *  do this kind of thing?"; only an ownership check answers "may THIS driver do it to THIS
 *  ride?". `assertCanAccept` is a precondition, not the concurrency control. */
export interface Principal {
  readonly userId: string;
  readonly role: 'RIDER' | 'DRIVER';
  readonly sessionId: string;
}

export function assertRole(p: Principal, required: 'RIDER' | 'DRIVER'): void {
  if (p.role !== required) {
    throw new ForbiddenRoleError(p.role);
  }
}

export function assertCanView(ride: Ride, p: Principal): void {
  if (ride.riderId === p.userId) return;
  if (ride.driverId === p.userId) return;
  // 404, not 403 — a 403 would confirm the ride exists.
  throw new RideNotVisibleError(ride.id);
}

/** Cancellation is the one permission that depends on `ride.status`, so it cannot live in a
 *  role table: a rider may cancel only while `REQUESTED` — once a driver commits, stopping it
 *  is a no-show — while the assigned driver may end any live ride and stays on the row. */
export function assertCanCancel(ride: Ride, p: Principal): void {
  assertCanView(ride, p);

  if (p.role === 'RIDER') {
    if (ride.riderId !== p.userId) throw new RideNotVisibleError(ride.id);
    if (ride.status !== 'REQUESTED') {
      // Entitled to cancel — just not from here. 409, not 403.
      throw new InvalidTransitionError(ride.status, 'CANCELLED');
    }
    return;
  }

  if (ride.driverId !== p.userId) throw new NotAssignedDriverError(ride.id);
  // Terminal rides are rejected here too rather than assumed handled upstream.
  if (!DRIVER_CANCELLABLE_STATUSES.includes(ride.status)) {
    throw new InvalidTransitionError(ride.status, 'CANCELLED');
  }
}

export const DRIVER_CANCELLABLE_STATUSES: readonly RideStatus[] = ['ACCEPTED', 'IN_PROGRESS'];

export function assertCanAccept(ride: Ride, p: Principal): void {
  if (p.role !== 'DRIVER') throw new ForbiddenRoleError(p.role);
  if (ride.driverId !== null) throw new RideAlreadyAcceptedError(ride.id);
  if (ride.status !== 'REQUESTED') {
    throw new RideNotAcceptableError(ride.id, ride.status);
  }
}

export function assertCanTransition(ride: Ride, p: Principal, to: RideStatus): void {
  assertCanView(ride, p);

  if (to === 'ACCEPTED') {
    assertCanAccept(ride, p);
    return;
  }

  // Must precede the DRIVER short-circuit below, which returns for every status
  // and would otherwise approve a cancellation without consulting assertCanCancel.
  if (to === 'CANCELLED') {
    assertCanCancel(ride, p);
    return;
  }

  if (p.role === 'DRIVER') {
    if (ride.driverId !== p.userId) throw new NotAssignedDriverError(ride.id);
    return;
  }

  throw new ForbiddenRoleError(p.role);
}

export function canSubscribeToRide(ride: Ride, p: Principal): boolean {
  return ride.riderId === p.userId || ride.driverId === p.userId;
}

/** Location frames are only accepted from the assigned driver while the ride is live. */
export function canPublishLocation(
  ride: Ride,
  p: Principal,
  to: RideStatus,
): boolean {
  return (
    p.role === 'DRIVER' &&
    ride.driverId === p.userId &&
    (to === 'ACCEPTED' || to === 'IN_PROGRESS')
  );
}
