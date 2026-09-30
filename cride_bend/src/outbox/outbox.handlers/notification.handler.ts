import { Injectable } from '@nestjs/common';
import { QueueProducer } from '../../platform/queue/producer';
import { recipientsFor } from '../../notifications/recipients';
import type { OutboxEnvelope, OutboxPublisher } from '../outbox.publisher';

/** The enqueue, kept off the request path entirely: FCM is not called from a use-case, a
 * job is. */
@Injectable()
export class NotificationHandler implements OutboxPublisher {
  constructor(private readonly producer: QueueProducer) {}

  canHandle(_eventType: OutboxEnvelope['eventType']): boolean {
    return true;
  }

  async handle(envelope: OutboxEnvelope): Promise<void> {
    const { eventType, aggregateId, payload, seq, correlationId } = envelope;

    // Who to tell is `recipientsFor`'s decision, shared with the inbox write.
    const recipients = recipientsFor(eventType, payload).map((r) => r.userId);

    // Idempotency key. Underscore separators: BullMQ rejects a custom jobId containing
    // ':' — see QueueProducer.send. It must be a pure function of (ride, seq, recipients)
    // so two relay attempts collide and dedupe, while distinct notifications do not.
    const jobId = `notif_${aggregateId}_${seq ?? 0}_${[...recipients].sort().join(',')}`;

    await this.producer.enqueueNotifications(
      eventType,
      { eventType, rideId: aggregateId, seq, correlationId, recipients, payload },
      { jobId },
    );
  }
}