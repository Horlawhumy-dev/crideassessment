import type { Money } from '../../kernel/money';

/** The boundary the application layer depends on: `rides` never learns that FCM exists. */
export interface PushMessage {
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
}

export interface PushPort {
  send(messages: readonly PushMessage[]): Promise<void>;
  /** FCM returns UNREGISTERED/INVALID_ARGUMENT for dead installs. */
  revokeToken(token: string): Promise<void>;
}

export type NotificationKind =
  | 'RIDE_REQUESTED'
  | 'RIDE_ACCEPTED'
  | 'RIDE_IN_PROGRESS'
  | 'RIDE_COMPLETED'
  | 'RIDE_CANCELLED';

export interface NotificationContext {
  readonly kind: NotificationKind;
  readonly rideId: string;
  readonly recipientId: string;
  readonly fare: Money | null;
  readonly correlationId: string;
  readonly seq: number;
}

export const PUSH_PORT = Symbol('PUSH_PORT');
