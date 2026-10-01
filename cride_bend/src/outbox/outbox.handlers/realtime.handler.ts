import { Inject, Injectable } from '@nestjs/common';
import { EVENT_BUS, RIDE_EVENT_TOPIC, type EventBus } from '../../platform/realtime/event-bus.port';
import type { OutboxEnvelope, OutboxPublisher } from '../outbox.publisher';

const HANDLED = new Set([
  'ride.requested', 'ride.accepted', 'ride.started', 'ride.completed', 'ride.cancelled',
]);

interface RideEventMessage {
  readonly rideId: string;
  readonly audience: 'ride' | 'drivers' | 'driver';
  readonly audienceId?: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

/** A ride that commits and then crashes mid-emit still reaches the rider, because the relay
 * re-drives it. This handler only translates an outbox row into a bus message. */
@Injectable()
export class RealtimeHandler implements OutboxPublisher {
  constructor(@Inject(EVENT_BUS) private readonly bus: EventBus) {}

  canHandle(eventType: OutboxEnvelope['eventType']): boolean {
    return HANDLED.has(eventType);
  }

  async handle(envelope: OutboxEnvelope): Promise<void> {
    const { eventType, aggregateId, payload, seq, correlationId } = envelope;
    const rideId = aggregateId;

    const base = {
      eventId: String(envelope.id),
      seq,
      rideId,
      ts: new Date().toISOString(),
      correlationId,
    };

    // The `event`/`audience` pairs below are the wire names rides.gateway.ts re-emits, not
    // outbox row names. The first goes to the ride room; one outbox event can fan out to
    // several distinct messages (see EgressGuard on why they must not dedupe together).
    await this.bus.publish(RIDE_EVENT_TOPIC, {
      rideId,
      audience: 'ride',
      event: 'ride:status_changed',
      payload: { ...base, status: STATUS_FOR[eventType] ?? 'REQUESTED' },
    } satisfies RideEventMessage);

    if (eventType === 'ride.accepted') {
      await this.bus.publish(RIDE_EVENT_TOPIC, {
        rideId,
        audience: 'ride',
        event: 'ride:assigned',
        payload: { ...base, driverId: payload['driverId'] },
      } satisfies RideEventMessage);
    }

    if (eventType === 'ride.requested') {
      await this.bus.publish(RIDE_EVENT_TOPIC, {
        rideId,
        audience: 'drivers',
        event: 'ride:offer',
        payload: { ...base, fareMinor: payload['fareMinor'], currency: payload['currency'] },
      } satisfies RideEventMessage);
    }

    if (eventType === 'ride.cancelled' && payload['driverId']) {
      await this.bus.publish(RIDE_EVENT_TOPIC, {
        rideId,
        audience: 'driver',
        audienceId: String(payload['driverId']),
        event: 'ride:released',
        payload: { rideId, ts: base.ts },
      } satisfies RideEventMessage);
    }
  }
}

const STATUS_FOR: Record<string, string> = {
  'ride.requested': 'REQUESTED',
  'ride.accepted': 'ACCEPTED',
  'ride.started': 'IN_PROGRESS',
  'ride.completed': 'COMPLETED',
  'ride.cancelled': 'CANCELLED',
};
