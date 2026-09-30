import type { OutboxEventType } from '../rides/application/ports/outbox.port';

export interface NotificationRecipient {
  readonly userId: string;
  /** Which side of the ride this user is on. Selects the wording of the copy. */
  readonly role: 'rider' | 'driver';
}

/**
 * Who an event notifies. One function, shared by the push enqueue and the inbox write,
 * because the two are answering the same question and must not answer it differently.
 *
 * The rule is "notify the party the event is *about*, not the one who caused it", with
 * two deliberate exceptions: the rider is never told about their own `ride.requested`
 * (they are looking at the screen that created it), and the driver is never told about
 * the `ride.accepted` they just performed.
 *
 * `ride.requested` fans out to every available driver, which is matching's job, not
 * this function's — hence the empty set.
 */
export function recipientsFor(
  eventType: OutboxEventType,
  payload: Record<string, unknown>,
): NotificationRecipient[] {
  if (eventType === 'ride.requested') return [];

  const recipients: NotificationRecipient[] = [];
  const riderId = payload['riderId'];
  const driverId = payload['driverId'];

  if (riderId) recipients.push({ userId: String(riderId), role: 'rider' });
  if (driverId && eventType !== 'ride.accepted') {
    recipients.push({ userId: String(driverId), role: 'driver' });
  }

  return recipients;
}

/**
 * The idempotency key for one (ride, event, recipient), deliberately the *same string*
 * `NotificationDedupe` builds in a different column of a different table: `NotificationDelivery`
 * and `InAppNotification` are separate tables because push and inbox are two independent
 * fates on one record — a push can fail while the inbox row was written, and the user still
 * saw the notification. Sharing the format lets the two be joined on it.
 *
 * `seq ?? 0` because a null seq is not a different event; it must still collide with its
 * own replay rather than producing a fresh key on every attempt.
 */
export function inAppDedupeKey(rideId: string, seq: number | null, userId: string): string {
  return `${rideId}:${seq ?? 0}:${userId}`;
}