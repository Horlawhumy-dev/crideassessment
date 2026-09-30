import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  IN_APP_NOTIFICATION_REPOSITORY,
  type InAppNotificationRepository,
  type NewInAppNotification,
} from '../../notifications/in-app.repository';
import { kindFor } from '../../notifications/kinds';
import { inAppDedupeKey, recipientsFor } from '../../notifications/recipients';
import { renderNotification, fareFromPayload } from '../../notifications/templates/ride-templates';
import type { OutboxEnvelope, OutboxPublisher } from '../outbox.publisher';

/** The inbox write, straight off the relay with no queue: an inbox row is one INSERT into
 * a table this process already talks to, and the outbox already supplies what the queue
 * was wanted for — the write lands only after the ride committed, and a crash between
 * commit and write leaves a PENDING row for the next poll. */
@Injectable()
export class InAppNotificationHandler implements OutboxPublisher {
  private readonly logger = new Logger(InAppNotificationHandler.name);

  constructor(
    @Inject(IN_APP_NOTIFICATION_REPOSITORY)
    private readonly inbox: InAppNotificationRepository,
  ) {}

  canHandle(_eventType: OutboxEnvelope['eventType']): boolean {
    return true;
  }

  async handle(envelope: OutboxEnvelope): Promise<void> {
    const { eventType, aggregateId, payload, seq } = envelope;

    const kind = kindFor(eventType);
    if (!kind) {
      // Logged, not thrown: returning successfully must not hold the row PENDING and
      // retry a message that will never be renderable.
      this.logger.warn('inapp.unknown_kind', { eventType });
      return;
    }

    const recipients = recipientsFor(eventType, payload);
    if (recipients.length === 0) return;

    const fare = fareFromPayload(payload);
    // `title`/`body` are picked explicitly rather than spread from
    // `renderNotification`: that returns a `data` bag for the FCM payload, which is not
    // a column here, and a spread smuggles it into `createMany` where Prisma rejects
    // the unknown argument.
    const rows: NewInAppNotification[] = recipients.map((recipient) => {
      const message = renderNotification(kind, { rideId: aggregateId, fare, actor: recipient.role });
      return {
        dedupeKey: inAppDedupeKey(aggregateId, seq, recipient.userId),
        userId: recipient.userId,
        rideId: aggregateId,
        kind,
        title: message.title,
        body: message.body,
      };
    });

    const inserted = await this.inbox.recordAll(rows);

    // A persistent gap here means duplicate dispatch is happening far more often than
    // it should, so it is worth a debug line.
    if (inserted < rows.length) {
      this.logger.debug('inapp.deduped', {
        rideId: aggregateId,
        seq,
        attempted: rows.length,
        inserted,
      });
    }
  }
}