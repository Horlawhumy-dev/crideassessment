import type { RideStatus } from './types';

// Re-exported so a feature imports the status type and its presentation from one
// place, and cannot end up with two ideas of what a status is.
export type { RideStatus };

/**
 * §5.11 — the one place a ride status becomes a colour and a sentence.
 *
 * The `Record<RideStatus, …>` is the whole point. The previous app carried four
 * competing vocabularies at once: the Prisma enum, a `Record` keyed by
 * `'requested' | 'accepted' | 'arrived' | 'in-progress' | 'completed'` in a
 * component, `'In transit' | 'Arriving' | 'Waiting'` in a mock-data file, and
 * whatever a screen happened to render. If the backend adds a sixth status and
 * the types are regenerated, **this file stops compiling** until someone decides
 * how it looks. That is the mechanism, and it is worth more than the table.
 *
 * `progress` drives the timeline, so a rider can see how far along they are
 * without the screen knowing the lifecycle.
 */

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'destructive';

export interface RideStatusMeta {
  /** What a person calls it. Never the enum, spelled differently. */
  readonly label: string;
  readonly tone: Tone;
  /** 0–1. Position along the rider's expected journey. */
  readonly progress: number;
  /** One line, in the rider's or driver's language, not the system's. */
  readonly description: string;
}

export const RIDE_STATUS_META: Record<RideStatus, RideStatusMeta> = {
  REQUESTED: {
    label: 'Finding a driver',
    tone: 'info',
    progress: 0.15,
    description: 'We are looking for a nearby driver and will update you the moment one accepts.',
  },
  ACCEPTED: {
    label: 'Driver on the way',
    tone: 'warning',
    progress: 0.45,
    description: 'Your driver is heading to the pickup point.',
  },
  IN_PROGRESS: {
    label: 'On the trip',
    tone: 'info',
    progress: 0.8,
    description: 'You are on the way to your destination.',
  },
  COMPLETED: {
    label: 'Completed',
    tone: 'success',
    progress: 1,
    description: 'Trip finished. Thanks for riding with C-Ride.',
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'destructive',
    progress: 0,
    description: 'This ride was cancelled and will not go ahead.',
  },
};

/**
 * The three non-terminal states, as the `status` query parameter wants them.
 *
 * "What is my current ride?" is the first question both home screens ask, and it
 * is the reason `status` on the API accepts a comma-separated list. Spelling the
 * filter here rather than inline means the rider's screen and the driver's screen
 * cannot disagree about which states count as live.
 */
export const ACTIVE_STATUS_FILTER = 'REQUESTED,ACCEPTED,IN_PROGRESS';

/** Terminal states end the journey. Nothing transitions out of them. */
export const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED'] as const satisfies readonly RideStatus[];

export function isTerminal(status: RideStatus): boolean {
  return (TERMINAL_STATUSES as readonly RideStatus[]).includes(status);
}

export function isActive(status: RideStatus): boolean {
  return !isTerminal(status);
}

/**
 * The states a viewer may legally *initiate*, derived from the backend's own
 * policy rather than restated.
 *
 * §4.13: once a driver is committed a rider may not unilaterally cancel, which is
 * the single most surprising rule in the system and the one a UI is most likely to
 * get wrong by showing a Cancel button on an accepted ride.
 *
 * Cancellation is the asymmetric case and it shows up here as a fork rather than a
 * single rule. A rider may cancel only while `REQUESTED`. A driver may cancel the
 * ride they hold, because they are the only party who can know the trip is
 * impossible — the vehicle has broken down, the rider is not there. Cancelling is
 * not a rare or shameful action for a driver, so the button sits alongside the
 * normal ones rather than hidden behind a menu.
 *
 * `REQUESTED -> CANCELLED` for a driver is NOT offered here even though the backend
 * transition map permits the edge: an unassigned driver is not a participant in
 * that ride, `assertCanView` answers 404 for them, and offering a button whose only
 * possible result is an error is the same mistake as the old dashboard's.
 */
export function allowedActions(status: RideStatus, role: 'RIDER' | 'DRIVER'): RideStatus[] {
  if (role === 'RIDER') {
    return status === 'REQUESTED' ? ['CANCELLED'] : [];
  }

  switch (status) {
    case 'REQUESTED':
      // Offered in the offer queue, where accepting is the only action rendered.
      // Kept for parity with the server's edge; see the note above.
      return ['ACCEPTED', 'CANCELLED'];
    case 'ACCEPTED':
      return ['IN_PROGRESS', 'CANCELLED'];
    case 'IN_PROGRESS':
      return ['COMPLETED', 'CANCELLED'];
    default:
      return [];
  }
}

export const ACTION_LABEL: Partial<Record<RideStatus, string>> = {
  ACCEPTED: 'Accept ride',
  IN_PROGRESS: 'Start trip',
  COMPLETED: 'Complete trip',
  CANCELLED: 'Cancel ride',
};
