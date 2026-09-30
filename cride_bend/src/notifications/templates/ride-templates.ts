import type { Money } from '../../kernel/money';
import type { NotificationKind } from '../../platform/push/push.port';

export interface RenderedMessage {
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
}

const money = (m: Money | null): string =>
  m ? `${(Number(m.amountMinor) / 100).toFixed(2)} ${m.currency}` : '—';

/**
 * The payload is `Json`, so `fareMinor` arrives as a number or as a string once it has been
 * through a round trip that widened BigInt. `String()` then `BigInt()` takes both and throws
 * on anything non-integer, which is right: an unparseable fare is a bug worth a retry rather
 * than copy that silently reads "—".
 */
export function fareFromPayload(payload: Record<string, unknown>): Money | null {
  const minor = payload['fareMinor'];
  if (minor === undefined || minor === null) return null;
  return {
    amountMinor: BigInt(String(minor)),
    currency: String(payload['currency'] ?? 'USD'),
  };
}

/** Pure: event -> message. No FCM types, no I/O, so the FCM adapter stays a transport. */
export function renderNotification(
  kind: NotificationKind,
  ctx: { rideId: string; fare: Money | null; actor: 'rider' | 'driver' },
): RenderedMessage {
  const shortId = ctx.rideId.slice(0, 8);

  switch (kind) {
    case 'RIDE_REQUESTED':
      return {
        title: 'New ride request',
        body: `Pickup is waiting. Fare ${money(ctx.fare)}.`,
        data: { kind, rideId: ctx.rideId },
      };
    case 'RIDE_ACCEPTED':
      return {
        title: 'Driver assigned',
        body: ctx.actor === 'rider'
          ? 'A driver has accepted your ride and is on the way.'
          : `You accepted ride ${shortId}. Head to pickup.`,
        data: { kind, rideId: ctx.rideId },
      };
    case 'RIDE_IN_PROGRESS':
      return {
        title: 'Trip started',
        body: ctx.actor === 'rider' ? 'Your trip is under way.' : 'The trip has started.',
        data: { kind, rideId: ctx.rideId },
      };
    case 'RIDE_COMPLETED':
      return {
        title: 'Trip complete',
        body: ctx.actor === 'rider'
          ? `You have arrived. Fare ${money(ctx.fare)}.`
          : `Ride ${shortId} completed. Fare ${money(ctx.fare)}.`,
        data: { kind, rideId: ctx.rideId },
      };
    case 'RIDE_CANCELLED':
      return {
        title: 'Ride cancelled',
        body: `Ride ${shortId} was cancelled.`,
        data: { kind, rideId: ctx.rideId },
      };
  }
}
