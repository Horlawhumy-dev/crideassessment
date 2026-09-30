import type { Money } from '../../../kernel/money';
import type { TransactionContext } from '../../../kernel/transaction';
import type { RideEvent } from '../../domain/ride';
import type { RideActor, RideStatus } from '../../domain/ride-status';

export const RIDE_EVENTS_PORT = Symbol('RIDE_EVENTS_PORT');

/** `seq` is per-ride and monotonic, which is what makes resync provable. */
export interface RideEventInput {
  readonly tx: TransactionContext;
  readonly rideId: string;
  readonly seq: number;
  readonly eventType: string;
  readonly actorId: string | null;
  readonly actorRole: RideActor | null;
  readonly payload: Record<string, unknown>;
}

export interface RideEventsPort {
  append(input: RideEventInput): Promise<RideEvent>;
}

export interface FareSnapshot {
  readonly fare: Money;
  readonly status: RideStatus;
}
