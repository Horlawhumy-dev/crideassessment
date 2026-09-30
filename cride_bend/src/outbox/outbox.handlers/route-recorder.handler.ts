import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { ROUTE_BUFFER, type RouteBuffer } from '../../tracking/route-buffer.port';
import type { OutboxEnvelope, OutboxPublisher } from '../outbox.publisher';

/** The durable polyline, written once when the trip ends. Driven by the outbox rather than
 * called from the transition use-case because the buffer is in Redis and the rows are in
 * Postgres, with no transaction spanning both — and because 2,000 route points do not belong
 * on the request path of `PATCH /rides/:id/status`. */
@Injectable()
export class RouteRecorderHandler implements OutboxPublisher {
  private readonly logger = new Logger(RouteRecorderHandler.name);

  constructor(
    @Inject(ROUTE_BUFFER) private readonly buffer: RouteBuffer,
    private readonly prisma: PrismaService,
  ) {}

  canHandle(eventType: OutboxEnvelope['eventType']): boolean {
    return eventType === 'ride.completed';
  }

  async handle(envelope: OutboxEnvelope): Promise<void> {
    const rideId = envelope.aggregateId;

    // `drain` on a ride that buffered nothing is a wasted round trip, and a very
    // short trip is the common case for `ride.completed`.
    if ((await this.buffer.size(rideId)) === 0) return;

    const samples = await this.buffer.drain(rideId);
    if (samples.length === 0) return;

    // seq is 1-based to match `ride_events`, so the two streams can be reasoned
    // about together and neither starts at a magic zero. `skipDuplicates` against the
    // (rideId, seq) unique index is what makes the at-least-once retry safe.
    const written = await this.prisma.routePoint.createMany({
      data: samples.map((s, i) => ({
        rideId,
        seq: i + 1,
        lat: s.lat,
        lng: s.lng,
        speedKph: s.speedKph,
        headingDeg: s.headingDeg,
        recordedAt: s.recordedAt,
      })),
      skipDuplicates: true,
    });

    this.logger.log('route.recorded', {
      rideId,
      points: written.count,
      correlationId: envelope.correlationId,
    });
  }
}