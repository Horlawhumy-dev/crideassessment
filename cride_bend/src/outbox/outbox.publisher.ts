import type { OutboxEventType } from '../rides/application/ports/outbox.port';

export interface OutboxEnvelope<T = Record<string, unknown>> {
  readonly id: bigint;
  readonly eventType: OutboxEventType;
  readonly aggregateId: string;
  readonly payload: T;
  readonly seq: number | null;
  readonly correlationId: string;
  readonly attempts: number;
}

export type OutboxHandler = (envelope: OutboxEnvelope) => Promise<void>;

/** Handlers register per consumer, so adding one never touches the ride use-case.
 * `canHandle` lets a handler opt out of events it does not care about. */
export interface OutboxPublisher {
  canHandle(eventType: OutboxEventType): boolean;
  handle(envelope: OutboxEnvelope): Promise<void>;
}
