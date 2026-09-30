import type { Tone } from './ride-status';
import type { InAppNotificationKind } from './types';

/**
 * §5.11 applied to notifications — the one place a notification kind becomes an
 * icon, a colour and a sentence.
 *
 * `Record<InAppNotificationKind, …>` for the same reason `RIDE_STATUS_META` is a
 * `Record<RideStatus, …>`: the backend owns the vocabulary, the generated types
 * carry it, and adding a kind there stops this file compiling until someone
 * decides what it looks like. A `switch` with a `default` would instead render
 * the new kind as an unlabelled grey dot, which is the failure mode this file
 * exists to prevent.
 *
 * The `title` and `body` that actually appear in the inbox are **not** from this
 * table. They are rendered on the server at the moment the event happened and
 * frozen into the row, so the copy a notification carries is the copy that was
 * true then and cannot be rewritten by a later template change. What lives here
 * is only the visual treatment: which icon, which tone.
 */

export interface NotificationKindMeta {
  readonly icon: 'car' | 'user' | 'play' | 'check' | 'ban';
  readonly tone: Tone;
}

export const NOTIFICATION_KIND_META: Record<InAppNotificationKind, NotificationKindMeta> = {
  RIDE_REQUESTED: { icon: 'car', tone: 'info' },
  RIDE_ACCEPTED: { icon: 'user', tone: 'warning' },
  RIDE_IN_PROGRESS: { icon: 'play', tone: 'info' },
  RIDE_COMPLETED: { icon: 'check', tone: 'success' },
  RIDE_CANCELLED: { icon: 'ban', tone: 'destructive' },
};