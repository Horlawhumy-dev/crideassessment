import { randomUUID } from 'node:crypto';
import type { Money } from '../kernel/money';
import type { Page } from '../kernel/page-cursor';
import type { TransactionContext, TransactionRunner } from '../kernel/transaction';
import type { RideRepository, CreateRideInput, ListRidesFilter } from '../rides/application/ports/ride.repository';
import type { OutboxPort, OutboxEvent } from '../rides/application/ports/outbox.port';
import type { RideCachePort } from '../rides/application/ports/ride-cache.port';
import type { RideEventsPort, RideEventInput } from '../rides/application/ports/ride-events.port';
import type { Ride, RideEvent } from '../rides/domain/ride';
import type { RideActor, RideStatus } from '../rides/domain/ride-status';

/**
 * §10.1 — in-memory test doubles for the ports.
 *
 * The `FakeRideRepository` is the important one. It reproduces the *conditional
 * update* semantics of the real adapter — the WHERE-clause predicate — rather than
 * recording whether a method was called. A jest.fn() mock would let a test pass
 * while the production SQL degraded to SELECT-then-UPDATE, which is the exact bug
 * the concurrency design exists to prevent.
 *
 * `runImmediately` is the other deliberate choice: the fake transaction provides
 * no isolation, so a use-case can only pass if its correctness comes from the
 * conditional write and not from the surrounding transaction. A test that only
 * passes under real isolation is testing the wrong thing.
 */

export function aRide(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 'ride-1',
    riderId: 'rider-1',
    driverId: null,
    status: 'REQUESTED',
    version: 1,
    pickup: { lat: 51.5074, lng: -0.1278 },
    dropoff: { lat: 51.52, lng: -0.1 },
    pickupAddress: 'A',
    dropoffAddress: 'B',
    fare: { amountMinor: 500n, currency: 'USD' },
    cancelledBy: null,
    cancelReason: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

export class FakeRideRepository implements RideRepository {
  readonly writes: string[] = [];

  constructor(private row: Ride | null = null) {}

  current(): Ride | null {
    return this.row;
  }

  async findById(_rideId: string, _tx?: TransactionContext): Promise<Ride | null> {
    return this.row;
  }

  async findActiveByRider(riderId: string): Promise<Ride | null> {
    if (!this.row || this.row.riderId !== riderId) return null;
    return ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS'].includes(this.row.status)
      ? this.row
      : null;
  }

  async findMany(_filter: ListRidesFilter): Promise<Page<Ride>> {
    return { items: this.row ? [this.row] : [], nextCursor: null, hasMore: false };
  }

  async listEvents(_rideId: string, afterSeq = 0): Promise<RideEvent[]> {
    return [];
  }

  async create(_tx: TransactionContext, input: CreateRideInput): Promise<Ride> {
    this.writes.push('create');
    this.row = aRide({
      id: input.id,
      riderId: input.riderId,
      pickup: input.pickup,
      dropoff: input.dropoff,
      fare: input.fare,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return this.row;
  }

  async acceptIfRequested(
    _tx: TransactionContext,
    _rideId: string,
    driverId: string,
    expectedVersion: number,
    now: Date,
  ): Promise<boolean> {
    if (!this.row) return false;

    // UPDATE ... WHERE status = 'REQUESTED' AND driver_id IS NULL AND version = ?
    if (this.row.status !== 'REQUESTED') return false;
    if (this.row.driverId !== null) return false;
    if (this.row.version !== expectedVersion) return false;

    this.writes.push('acceptIfRequested');
    this.row = {
      ...this.row,
      driverId,
      status: 'ACCEPTED',
      acceptedAt: now,
      updatedAt: now,
      version: this.row.version + 1,
    };
    return true;
  }

  async transitionWithVersion(
    _tx: TransactionContext,
    _rideId: string,
    to: RideStatus,
    expectedVersion: number,
    currentDriverId: string | null,
    actor: RideActor,
    cancelReason: string | null,
    now: Date,
  ): Promise<boolean> {
    if (!this.row) return false;
    if (this.row.version !== expectedVersion) return false;
    if (this.row.driverId !== currentDriverId) return false;

    this.writes.push(`transition:${to}`);
    this.row = {
      ...this.row,
      status: to,
      updatedAt: now,
      version: this.row.version + 1,
      ...(to === 'IN_PROGRESS' ? { startedAt: now } : {}),
      ...(to === 'COMPLETED' ? { completedAt: now } : {}),
      ...(to === 'CANCELLED' ? { cancelledBy: actor, cancelReason } : {}),
    };
    return true;
  }

  async appendEvent(rideId: string, event: Omit<RideEvent, 'id' | 'rideId' | 'createdAt'>): Promise<RideEvent> {
    const full: RideEvent = {
      ...event,
      id: randomUUID(),
      rideId,
      createdAt: new Date(),
    };
    return full;
  }

  async nextSeq(): Promise<number> {
    return 0;
  }
}

export class FakeOutbox implements OutboxPort {
  readonly events: OutboxEvent[] = [];

  async enqueue(_tx: TransactionContext, event: OutboxEvent): Promise<void> {
    this.events.push(event);
  }
}

export class FakeEvents implements RideEventsPort {
  readonly appended: RideEventInput[] = [];
  private seq = 0;

  async append(input: RideEventInput): Promise<RideEvent> {
    this.appended.push(input);
    this.seq = Math.max(this.seq, input.seq);
    return {
      id: randomUUID(),
      rideId: input.rideId,
      seq: input.seq,
      eventType: input.eventType,
      actorId: input.actorId,
      actorRole: input.actorRole,
      payload: input.payload,
      createdAt: new Date(),
    };
  }

  highestSeq(): number {
    return this.seq;
  }
}

export class FakeCache implements RideCachePort {
  readonly invalidated: string[] = [];
  readonly invalidatedRiders: string[] = [];
  private readonly store = new Map<string, Ride>();
  private failSet = false;

  async get(rideId: string): Promise<Ride | null> {
    return this.store.get(rideId) ?? null;
  }

  async set(ride: Ride): Promise<void> {
    this.store.set(ride.id, ride);
  }

  async invalidate(rideId: string): Promise<void> {
    this.invalidated.push(rideId);
    this.store.delete(rideId);
  }

  async invalidateRider(riderId: string): Promise<void> {
    this.invalidatedRiders.push(riderId);
  }

  /** Simulates Redis being unavailable, to prove the request path still succeeds. */
  setFailing(value: boolean): void {
    this.failSet = value;
    if (value) {
      this.store.clear();
    }
  }

  get failing(): boolean {
    return this.failSet;
  }
}

/** A transaction that provides no isolation, on purpose. See the file header. */
export const immediateTransaction: TransactionRunner = {
  run: <T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> => fn(undefined),
};

export function aMoney(amountMinor: bigint, currency = 'USD'): Money {
  return { amountMinor, currency };
}
