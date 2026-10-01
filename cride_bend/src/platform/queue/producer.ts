import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { MetricsService } from '../otel/metrics';
import { QUEUE_RIDE_NOTIFICATIONS, QUEUE_RIDE_MATCHING, type QueueName } from './queues';

export interface EnqueueOptions {
  /** Stable key so a duplicate enqueue is a no-op rather than a second delivery.
   * Must use `_`, never `:` — see `send`. */
  jobId?: string;
  delayMs?: number;
}

/** BullMQ producer. The API process enqueues; the worker process consumes. Nothing in the
 * ride transaction depends on this succeeding — the ride use-case calls it from inside the
 * outbox handler, long after the ride row is committed. */
@Injectable()
export class QueueProducer {
  private readonly logger = new Logger(QueueProducer.name);

  constructor(
    @InjectQueue(QUEUE_RIDE_NOTIFICATIONS) private readonly notifications: Queue,
    @InjectQueue(QUEUE_RIDE_MATCHING) private readonly matching: Queue,
    private readonly metrics: MetricsService,
  ) {}

  async enqueueNotifications(
    name: string,
    data: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<void> {
    await this.send(this.notifications, name, data, opts);
  }

  async enqueueMatching(
    name: string,
    data: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<void> {
    await this.send(this.matching, name, data, opts);
  }

  /**
   * Rejects rather than swallowing: `OutboxRelay.dispatch` picks between PUBLISHED and retry
   * purely on whether the handler rejected, so a swallowed error reads as success, the row is
   * marked PUBLISHED, and the retry ladder and dead-letter state are unreachable.
   */
  private async send(
    queue: Queue,
    name: string,
    data: Record<string, unknown>,
    opts: EnqueueOptions,
  ): Promise<void> {
    try {
      await queue.add(name, data, {
        // BullMQ reserves ':' in Redis keys and rejects a custom jobId containing it
        // ("Custom Id cannot contain :"), so callers must build ids with '_'.
        jobId: opts.jobId,
        delay: opts.delayMs,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
        backoff: { type: 'exponential', delay: 2_000 },
      });
    } catch (err) {
      this.metrics.counter('queue_enqueue_failed_total').inc({ queue: queue.name as QueueName });
      this.logger.error('queue.enqueue_failed', {
        queue: queue.name,
        name,
        jobId: opts.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
