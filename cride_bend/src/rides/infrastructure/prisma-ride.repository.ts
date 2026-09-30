import { Injectable } from '@nestjs/common';
import { RideStatus as PrismaRideStatus } from '@prisma/client';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { asPrisma } from '../../platform/prisma/prisma-transaction.adapter';
import { pageOf, type Page, type PageCursor } from '../../kernel/page-cursor';
import type { TransactionContext } from '../../kernel/transaction';
import type { Ride, RideEvent } from '../domain/ride';
import { ACTIVE_STATUSES, type RideActor, type RideStatus } from '../domain/ride-status';
import {
  RIDE_REPOSITORY,
  type CreateRideInput,
  type ListRidesFilter,
  type RideRepository,
} from '../application/ports/ride.repository';
import { toDomain } from './rides.mapper';

@Injectable()
export class PrismaRideRepository implements RideRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(rideId: string, tx?: TransactionContext): Promise<Ride | null> {
    const client = tx ? asPrisma(tx) : this.prisma;
    const row = await client.ride.findUnique({ where: { id: rideId } });
    return row ? toDomain(row) : null;
  }

  async findActiveByRider(riderId: string, tx?: TransactionContext): Promise<Ride | null> {
    const client = tx ? asPrisma(tx) : this.prisma;
    const row = await client.ride.findFirst({
      where: { riderId, status: { in: ACTIVE_STATUSES as PrismaRideStatus[] } },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toDomain(row) : null;
  }

  async findMany(filter: ListRidesFilter): Promise<Page<Ride>> {
    const where = {
      ...(filter.riderId ? { riderId: filter.riderId } : {}),
      ...(filter.driverId ? { driverId: filter.driverId } : {}),
      ...(filter.status ? { status: filter.status as PrismaRideStatus } : {}),
      ...(filter.statuses
        ? { status: { in: [...filter.statuses] as PrismaRideStatus[] } }
        : {}),
      // Keyset on (createdAt, id): rides can share a createdAt to the millisecond,
      // so paging on createdAt alone would skip or repeat rows at a page boundary.
      ...(filter.cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(filter.cursor.createdAt) } },
              { createdAt: new Date(filter.cursor.createdAt), id: { lt: filter.cursor.id } },
            ],
          }
        : {}),
    };

    // One extra row detects hasMore without a second COUNT query.
    const rows = await this.prisma.ride.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });

    return pageOf(
      rows.map(toDomain),
      filter.limit,
      (r): PageCursor => ({ createdAt: r.createdAt.toISOString(), id: r.id }),
    );
  }

  async listEvents(rideId: string, afterSeq = 0): Promise<RideEvent[]> {
    const rows = await this.prisma.rideEvent.findMany({
      where: { rideId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      rideId: r.rideId,
      seq: r.seq,
      eventType: r.eventType,
      actorId: r.actorId,
      actorRole: r.actorRole,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Guard and write in one statement. `driverId: null` is not redundant with
   * `status = REQUESTED`: it makes a partially-written accept impossible to win
   * again, and `version` is the second line of defence against a concurrent write.
   */
  async acceptIfRequested(
    tx: TransactionContext,
    rideId: string,
    driverId: string,
    expectedVersion: number,
    now: Date,
  ): Promise<boolean> {
    const result = await asPrisma(tx).ride.updateMany({
      where: { id: rideId, status: 'REQUESTED', driverId: null, version: expectedVersion },
      data: {
        driverId,
        status: 'ACCEPTED',
        acceptedAt: now,
        updatedAt: now,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  /**
   * Optimistic concurrency. `driverId` is in the predicate, not just the data, so a
   * write cannot land on a ride whose driver changed between read and write.
   */
  async transitionWithVersion(
    tx: TransactionContext,
    rideId: string,
    to: RideStatus,
    expectedVersion: number,
    currentDriverId: string | null,
    actor: RideActor,
    cancelReason: string | null,
    now: Date,
  ): Promise<boolean> {
    const result = await asPrisma(tx).ride.updateMany({
      where: { id: rideId, version: expectedVersion, driverId: currentDriverId },
      data: {
        status: to as PrismaRideStatus,
        updatedAt: now,
        version: { increment: 1 },
        ...(to === 'IN_PROGRESS' ? { startedAt: now } : {}),
        ...(to === 'COMPLETED' ? { completedAt: now } : {}),
        // `actor`, not a hardcoded RIDER: the audit trail must name a driver cancel.
        ...(to === 'CANCELLED' ? { cancelledBy: actor, cancelReason } : {}),
      },
    });
    return result.count === 1;
  }

  async create(tx: TransactionContext, input: CreateRideInput): Promise<Ride> {
    const row = await asPrisma(tx).ride.create({
      data: {
        id: input.id,
        riderId: input.riderId,
        status: 'REQUESTED',
        // Matches the schema default, set explicitly so the first optimistic update
        // is written against a known value.
        version: 1,
        pickupLat: input.pickup.lat,
        pickupLng: input.pickup.lng,
        dropoffLat: input.dropoff.lat,
        dropoffLng: input.dropoff.lng,
        pickupAddress: input.pickupAddress,
        dropoffAddress: input.dropoffAddress,
        fareMinor: input.fare.amountMinor,
        currency: input.fare.currency,
        createdAt: input.now,
        updatedAt: input.now,
      },
    });
    return toDomain(row);
  }

  async appendEvent(
    rideId: string,
    event: Omit<RideEvent, 'id' | 'rideId' | 'createdAt'>,
  ): Promise<RideEvent> {
    const row = await this.prisma.rideEvent.create({
      data: {
        rideId,
        seq: event.seq,
        eventType: event.eventType,
        actorId: event.actorId,
        actorRole: event.actorRole,
        payload: event.payload as object,
      },
    });
    return {
      id: row.id,
      rideId,
      seq: row.seq,
      eventType: row.eventType,
      actorId: row.actorId,
      actorRole: row.actorRole,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
    };
  }

  async nextSeq(tx: TransactionContext, rideId: string): Promise<number> {
    const last = await asPrisma(tx).rideEvent.findFirst({
      where: { rideId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return last?.seq ?? 0;
  }
}

export { RIDE_REPOSITORY };
