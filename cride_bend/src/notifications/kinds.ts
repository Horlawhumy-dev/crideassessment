import { InAppNotificationKind } from '@prisma/client';

import type { OutboxEventType } from '../rides/application/ports/outbox.port';
import type { NotificationKind } from '../platform/push/push.port';

/**
 * `NotificationKind` (TypeScript) and `InAppNotificationKind` (a Prisma enum in
 * schema.prisma) name the same five events and cannot be one declaration: Prisma reads
 * its enums out of schema.prisma and cannot import a type. So the duplication is asserted
 * by `KINDS_MATCH` below, which fails to compile if either side gains or loses a member.
 */

/** Exact type equality. The deferred conditional compares structurally rather than testing
 * assignability, which would accept a subset — and a subset is the drift guarded against. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const KINDS_MATCH: Exact<NotificationKind, InAppNotificationKind> = true;
void KINDS_MATCH;

const EVENT_KINDS: Record<OutboxEventType, NotificationKind> = {
  'ride.requested': 'RIDE_REQUESTED',
  'ride.accepted': 'RIDE_ACCEPTED',
  'ride.started': 'RIDE_IN_PROGRESS',
  'ride.completed': 'RIDE_COMPLETED',
  'ride.cancelled': 'RIDE_CANCELLED',
};

/** Total over `OutboxEventType`, so `undefined` names a case that cannot occur. It is still
 * returned because `NotificationProcessor` receives a `string` off a queue payload, and a
 * queue can outlive the schema that filled it. */
export function kindFor(eventType: string): NotificationKind | undefined {
  return EVENT_KINDS[eventType as OutboxEventType];
}

/** Read from Prisma rather than `NotificationKind` so the OpenAPI contract cannot drift
 * from the column the value is written to. */
export const IN_APP_NOTIFICATION_KINDS = Object.values(InAppNotificationKind);