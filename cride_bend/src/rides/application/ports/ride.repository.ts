import type { Money } from '../../../kernel/money';
import type { TransactionContext } from '../../../kernel/transaction';
import type { GeoPoint } from '../../../kernel/geo-point';
import type { Page, PageCursor } from '../../../kernel/page-cursor';
import type { Ride, RideEvent } from '../../domain/ride';
import type { RideActor, RideStatus } from '../../domain/ride-status';

export const RIDE_REPOSITORY = Symbol('RIDE_REPOSITORY');

export interface CreateRideInput {
  readonly id: string;
  readonly riderId: string;
  readonly pickup: GeoPoint;
  readonly dropoff: GeoPoint;
  readonly pickupAddress: string | null;
  readonly dropoffAddress: string | null;
  readonly fare: Money;
  readonly now: Date;
}

export interface ListRidesFilter {
  readonly riderId?: string;
  readonly driverId?: string;
  readonly status?: RideStatus;
  readonly statuses?: readonly RideStatus[];
  readonly cursor?: PageCursor;
  readonly limit: number;
}

/** The concurrency primitives live here; the conditional update is the authority. */
export interface RideRepository {
  findById(rideId: string, tx?: TransactionContext): Promise<Ride | null>;

  /** The rider's active ride. The partial unique index on (riderId) WHERE status IN
   *  ACTIVE_STATUSES is the real enforcement; this read only produces a better error. */
  findActiveByRider(riderId: string, tx?: TransactionContext): Promise<Ride | null>;

  findMany(filter: ListRidesFilter): Promise<Page<Ride>>;

  listEvents(rideId: string, afterSeq?: number): Promise<RideEvent[]>;

  create(tx: TransactionContext, input: CreateRideInput): Promise<Ride>;

  /** One atomic statement: 0 rows means disambiguate by reading the ride *after* the
   *  write, never before. */
  acceptIfRequested(
    tx: TransactionContext,
    rideId: string,
    driverId: string,
    expectedVersion: number,
    now: Date,
  ): Promise<boolean>;

  /** Optimistic concurrency: a stale client gets 409 instead of clobbering state. */
  transitionWithVersion(
    tx: TransactionContext,
    rideId: string,
    to: RideStatus,
    expectedVersion: number,
    currentDriverId: string | null,
    actor: RideActor,
    cancelReason: string | null,
    now: Date,
  ): Promise<boolean>;

  appendEvent(
    rideId: string,
    event: Omit<RideEvent, 'id' | 'rideId' | 'createdAt'>,
  ): Promise<RideEvent>;

  /** Last seq for a ride; called inside the same transaction as the write. */
  nextSeq(tx: TransactionContext, rideId: string): Promise<number>;
}
