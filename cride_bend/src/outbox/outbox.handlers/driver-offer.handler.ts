import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { QueueProducer } from '../../platform/queue/producer';
import type { OutboxEnvelope, OutboxPublisher } from '../outbox.publisher';

/** The hook for nearest-driver matching. Registered so the seam exists, but gated on
 * DRIVER_MATCHING_ENABLED, which defaults to false. */
@Injectable()
export class DriverOfferHandler implements OutboxPublisher {
  private readonly logger = new Logger(DriverOfferHandler.name);

  constructor(
    private readonly producer: QueueProducer,
    private readonly config: ConfigService,
  ) {}

  canHandle(eventType: OutboxEnvelope['eventType']): boolean {
    return eventType === 'ride.requested';
  }

  async handle(envelope: OutboxEnvelope): Promise<void> {
    const enabled = this.config.get<AppConfig>(APP_CONFIG)!.DRIVER_MATCHING_ENABLED;
    if (!enabled) {
      this.logger.debug('driver_offer.skipped', { reason: 'DRIVER_MATCHING_ENABLED=false' });
      return;
    }

    await this.producer.enqueueMatching(
      'match.ride',
      {
        rideId: envelope.aggregateId,
        seq: envelope.seq,
        correlationId: envelope.correlationId,
        payload: envelope.payload,
      },
      // Underscore, not colon: BullMQ rejects a custom jobId containing ':' — see
      // QueueProducer.send. Stable across relay retries, which is what dedupes it.
      { jobId: `match_${envelope.aggregateId}` },
    );
  }
}
