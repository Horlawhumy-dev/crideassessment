import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Inject, Logger } from '@nestjs/common';
import { QUEUE_RIDE_NOTIFICATIONS } from '../platform/queue/queues';
import { PUSH_PORT, type PushPort } from '../platform/push/push.port';
import { NotificationDedupe } from './dedupe';
import { DEVICE_TOKEN_REPOSITORY, type DeviceTokenRepository } from './device-token.repository';
import { kindFor } from './kinds';
import { inAppDedupeKey } from './recipients';
import { renderNotification, fareFromPayload } from './templates/ride-templates';

interface NotificationJob {
  eventType: string;
  rideId: string;
  seq: number | null;
  correlationId: string;
  recipients: string[];
  payload: Record<string, unknown>;
}

const MAX_DELIVERY_ATTEMPT = 3;

/** The only consumer of the ride-notifications queue. A dead FCM token is dropped rather
 * than retried: retrying a permanent failure is how a queue ends up wedged with jobs that
 * can never succeed. */
@Processor(QUEUE_RIDE_NOTIFICATIONS, { concurrency: 10 })
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @Inject(PUSH_PORT) private readonly push: PushPort,
    @Inject(DEVICE_TOKEN_REPOSITORY) private readonly devices: DeviceTokenRepository,
    private readonly dedupe: NotificationDedupe,
  ) {
    super();
  }

  async process(raw: Job<NotificationJob>): Promise<void> {
    const job = raw.data;
    const kind = kindFor(job.eventType);
    if (!kind) {
      // The one consumer reading a `string` off a queue payload, where a job enqueued by
      // an older deploy can name an event this build no longer has. Unrenderable is not
      // retryable, so this returns rather than throwing.
      this.logger.warn('notification.unknown_kind', { eventType: job.eventType });
      return;
    }

    const tokensByUser = await this.devices.activeTokensFor(job.recipients);

    for (const userId of job.recipients) {
      const tokens = tokensByUser.get(userId) ?? [];
      if (tokens.length === 0) {
        // Not an error: a rider on the web app legitimately has no device token. Their
        // inbox is a separate outbox consumer that does not consult this map.
        this.logger.debug('notification.no_device_token', { userId });
        continue;
      }

      // Dedupe key is (ride, seq, recipient), so three delivery attempts still produce
      // one notification.
      const dedupeKey = inAppDedupeKey(job.rideId, job.seq, userId);
      if (!(await this.dedupe.claim(dedupeKey, userId, job.rideId))) {
        this.logger.debug('notification.deduped', { dedupeKey });
        continue;
      }

      const message = renderNotification(kind, {
        rideId: job.rideId,
        fare: fareFromPayload(job.payload),
        actor: userId === job.payload.riderId ? 'rider' : 'driver',
      });

      try {
        await this.push.send(tokens.map((token) => ({ token, ...message })));
        await this.dedupe.recordSent(dedupeKey, userId, job.rideId);
      } catch (err) {
        await this.dedupe.recordFailed(dedupeKey, userId, job.rideId, String(err));
        throw err;
      }
    }
  }
}

export { MAX_DELIVERY_ATTEMPT };
