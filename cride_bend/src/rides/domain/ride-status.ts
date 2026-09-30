import { DomainError } from '../../common/errors/domain-error';

/**
 * The ride state machine. The two `Record<RideStatus, ...>` annotations are
 * exhaustiveness guards: adding a status without updating the maps is a compile
 * error, so every path is forced through them.
 */

export const RIDE_STATUSES = [
  'REQUESTED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

export type RideActor = 'RIDER' | 'DRIVER' | 'SYSTEM';

/**
 * The status graph — deliberately not an actor matrix. `ACCEPTED -> CANCELLED` and
 * `IN_PROGRESS -> CANCELLED` exist because the assigned driver may drop the trip; a
 * rider may not take either. Who may take which edge is `ride-policy.ts`'s job.
 */
export const RIDE_TRANSITIONS: Record<RideStatus, readonly RideStatus[]> = {
  REQUESTED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * Who may move a ride into each status. A list because `CANCELLED` has two legal
 * actors; the narrower "may THIS rider cancel yet?" is `assertCanCancel`, which
 * has the ride in hand. This table only knows roles.
 */
export const TRANSITION_ACTOR: Record<RideStatus, readonly RideActor[]> = {
  REQUESTED: ['RIDER'],
  ACCEPTED: ['DRIVER'],
  IN_PROGRESS: ['DRIVER'],
  COMPLETED: ['DRIVER'],
  CANCELLED: ['RIDER', 'DRIVER'],
};

export const TERMINAL_STATUSES: readonly RideStatus[] = ['COMPLETED', 'CANCELLED'];

export function isTerminal(status: RideStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Statuses in which a ride is still live and blocking further requests. */
export const ACTIVE_STATUSES: readonly RideStatus[] = [
  'REQUESTED',
  'ACCEPTED',
  'IN_PROGRESS',
];

export function isActive(status: RideStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function canTransition(from: RideStatus, to: RideStatus): boolean {
  return RIDE_TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: RideStatus): readonly RideStatus[] {
  return RIDE_TRANSITIONS[from];
}

export function actorFor(status: RideStatus): readonly RideActor[] {
  return TRANSITION_ACTOR[status];
}

/**
 * Both extend DomainError, so the exception filter maps them to their registered
 * status; as plain Errors they would surface as a generic 500 with no code for the
 * frontend to switch on.
 */
export class InvalidTransitionError extends DomainError {
  constructor(
    readonly from: RideStatus,
    readonly to: RideStatus,
  ) {
    super('INVALID_TRANSITION', `Cannot move a ride from ${from} to ${to}.`, { from, to });
  }
}

export class WrongActorError extends DomainError {
  constructor(
    readonly actor: RideActor,
    readonly target: RideStatus,
  ) {
    super(
      'WRONG_ACTOR_FOR_TRANSITION',
      `A ${actor.toLowerCase()} may not move a ride to ${target}.`,
      { actor, target },
    );
  }
}

/**
 * Combines the two rules: is the edge legal, and may this actor make it. `SYSTEM`
 * is deliberately absent from `TRANSITION_ACTOR`, so it is rejected here for every
 * status; `assertSystemExpiry` is the single exemption.
 */
export function assertTransition(
  from: RideStatus,
  to: RideStatus,
  actor: RideActor,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
  if (!TRANSITION_ACTOR[to].includes(actor)) {
    throw new WrongActorError(actor, to);
  }
}

export function assertTransitionForPrincipal(
  from: RideStatus,
  to: RideStatus,
  role: 'RIDER' | 'DRIVER',
): void {
  assertTransition(from, to, role);
}

/**
 * The one move a machine may make. Restricting it to `REQUESTED -> CANCELLED` is
 * the substance: a system may end an offer nobody took, never a ride with a driver
 * on it, and an expiry must be distinguishable from a driver cancelling.
 */
export function assertSystemExpiry(from: RideStatus, to: RideStatus): void {
  if (from !== 'REQUESTED' || to !== 'CANCELLED') {
    throw new InvalidTransitionError(from, to);
  }
}
