import { Prisma, type Ride as RideRow, type User } from '@prisma/client';
import type { Ride, RideEvent } from '../domain/ride';
import type { RideStatus } from '../domain/ride-status';
import { money, fromJSON, type Money } from '../../kernel/money';
import { round, type GeoPoint } from '../../kernel/geo-point';

/** The only place BigInt becomes a string; JSON.stringify throws on it. */
export function toDomain(row: RideRow & { rider?: User; driver?: User | null }): Ride {
  return {
    id: row.id,
    riderId: row.riderId,
    driverId: row.driverId,
    status: row.status as RideStatus,
    version: row.version,
    pickup: { lat: Number(row.pickupLat), lng: Number(row.pickupLng) },
    dropoff: { lat: Number(row.dropoffLat), lng: Number(row.dropoffLng) },
    pickupAddress: row.pickupAddress,
    dropoffAddress: row.dropoffAddress,
    fare: row.fareMinor !== null && row.fareMinor !== undefined
      ? money(row.fareMinor as bigint, row.currency)
      : null,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    acceptedAt: row.acceptedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** JSON-safe projection for the wire. */
export function toResponse(ride: Ride) {
  return {
    id: ride.id,
    status: ride.status,
    version: ride.version,
    riderId: ride.riderId,
    driverId: ride.driverId,
    pickup: ride.pickup,
    dropoff: ride.dropoff,
    pickupAddress: ride.pickupAddress,
    dropoffAddress: ride.dropoffAddress,
    fare: ride.fare ? toJSONMoney(ride.fare) : null,
    acceptedAt: ride.acceptedAt?.toISOString() ?? null,
    startedAt: ride.startedAt?.toISOString() ?? null,
    completedAt: ride.completedAt?.toISOString() ?? null,
    // Exposed because cancellation is the one transition whose reason matters to the
    // other party: the rider needs to know whether to wait or book again.
    cancelledBy: ride.cancelledBy,
    cancelReason: ride.cancelReason,
    createdAt: ride.createdAt.toISOString(),
    updatedAt: ride.updatedAt.toISOString(),
  };
}

export function toJSONMoney(m: Money) {
  return { amountMinor: m.amountMinor.toString(), currency: m.currency };
}

/**
 * Wire projection for one audit event. `createdAt` becomes an ISO string here so
 * the wire contract does not depend on the transport.
 */
export function toWireEvent(event: RideEvent) {
  return {
    id: event.id,
    rideId: event.rideId,
    seq: event.seq,
    eventType: event.eventType,
    actorId: event.actorId,
    actorRole: event.actorRole,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

export { fromJSON, round };
export type { GeoPoint };
export type { Prisma };
