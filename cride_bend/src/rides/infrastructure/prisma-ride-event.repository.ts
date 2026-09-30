import { Injectable } from '@nestjs/common';
import { asPrisma } from '../../platform/prisma/prisma-transaction.adapter';
import type { RideEvent } from '../domain/ride';
import {
  RIDE_EVENTS_PORT,
  type RideEventsPort,
  type RideEventInput,
} from '../application/ports/ride-events.port';

/** The unique (rideId, seq) constraint is what makes out-of-order guards and resync provable. */
@Injectable()
export class PrismaRideEventRepository implements RideEventsPort {
  async append(input: RideEventInput): Promise<RideEvent> {
    const row = await asPrisma(input.tx).rideEvent.create({
      data: {
        rideId: input.rideId,
        seq: input.seq,
        eventType: input.eventType,
        actorId: input.actorId,
        actorRole: input.actorRole,
        payload: input.payload as object,
      },
    });

    return {
      id: row.id,
      rideId: row.rideId,
      seq: row.seq,
      eventType: row.eventType,
      actorId: row.actorId,
      actorRole: row.actorRole,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
    };
  }
}

export { RIDE_EVENTS_PORT };
