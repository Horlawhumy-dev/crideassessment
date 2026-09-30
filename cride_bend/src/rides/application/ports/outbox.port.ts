import type { TransactionContext } from '../../../kernel/transaction';

export type { TransactionContext };

export const OUTBOX_PORT = Symbol('OUTBOX_PORT');

/** The event-name contract between the ride domain and every consumer. */
export type OutboxEventType =
  | 'ride.requested'
  | 'ride.accepted'
  | 'ride.started'
  | 'ride.completed'
  | 'ride.cancelled';

export interface OutboxEvent<T = Record<string, unknown>> {
  readonly type: OutboxEventType;
  readonly aggregateId: string;
  readonly seq: number;
  readonly correlationId: string;
  readonly payload: T;
}

export interface OutboxMessageRow {
  readonly id: bigint;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly seq: number | null;
  readonly correlationId: string;
}

export interface OutboxPort {
  /** Must be called inside the ride transaction. */
  enqueue(tx: TransactionContext, event: OutboxEvent): Promise<void>;
}
