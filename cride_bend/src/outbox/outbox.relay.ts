import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../platform/prisma/prisma.service';
import { MetricsService } from '../platform/otel/metrics';
import { OutboxHandler, type OutboxEnvelope, type OutboxPublisher } from './outbox.publisher';

const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 8;

/**
 * The transactional outbox is the only reason a committed ride cannot fail to notify
 * anyone: the row commits with the ride and the relay re-drives it until it lands.
 *
 * At-least-once, so every handler MUST be idempotent.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  /**
   * A Set keyed on object identity, not on class name: two consumers implemented by
   * the same class would silently overwrite each other, and only the last to register
   * would ever receive an event.
   */
  private readonly publishers = new Set<OutboxPublisher>();
  private running = false;
  private timer?: NodeJS.Timeout;
  // Carries the drained-batch count, which nothing awaits; typed as unknown so the
  // chain can hold whatever drainOnce resolves to.
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  register(publisher: OutboxPublisher): void {
    this.publishers.add(publisher);
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.timer = setInterval(() => {
      // `running` is checked here rather than relying on clearInterval alone, so a
      // drain already in flight when shutdown starts is still awaited by
      // onModuleDestroy rather than being abandoned mid-batch.
      if (!this.running) return;
      this.inFlight = this.inFlight.then(() => this.drainOnce()).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    this.logger.log('outbox.relay_started');
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    // Let the current batch finish so nothing is left half-processed.
    await this.inFlight.catch(() => undefined);
  }

  /** Exposed for tests and for the crash-recovery test. */
  async drainOnce(): Promise<number> {
    const claimed = await this.claimBatch();
    if (claimed.length === 0) return 0;

    for (const row of claimed) {
      await this.dispatch(row);
    }

    const oldest = claimed[0];
    if (oldest) {
      this.metrics.gauge('outbox_lag_seconds').set(
        (Date.now() - new Date(oldest.createdAt).getTime()) / 1000,
      );
    }

    return claimed.length;
  }

  private async claimBatch() {
    // findMany + updateMany in one transaction, so the claim and the PROCESSING flip
    // commit together and a crashed relay's rows roll back instead of being stranded.
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.outboxMessage.findMany({
        where: { status: 'PENDING', availableAt: { lte: new Date() } },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      });

      if (rows.length === 0) return [];

      await tx.outboxMessage.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { status: 'PROCESSING' },
      });

      return rows;
    });
  }

  /** PUBLISHED vs retry is decided purely on whether a handler rejected — never on what
   * the handler did internally. A DEAD row is marked, never deleted: "which ride never
   * got its notification" has to stay answerable. */
  private async dispatch(row: {
    id: bigint; eventType: string; aggregateId: string; payload: unknown;
    seq: number | null; correlationId: string; attempts: number; createdAt: Date;
  }): Promise<void> {
    const envelope: OutboxEnvelope = {
      id: row.id,
      eventType: row.eventType as OutboxEnvelope['eventType'],
      aggregateId: row.aggregateId,
      payload: row.payload as Record<string, unknown>,
      seq: row.seq,
      correlationId: row.correlationId,
      attempts: row.attempts,
    };

    const targets = [...this.publishers].filter((p) => p.canHandle(envelope.eventType));

    if (targets.length === 0) {
      await this.markPublished(row.id);
      return;
    }

    const results = await Promise.allSettled(
      targets.map((p) => p.handle(envelope)),
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length === 0) {
      await this.markPublished(row.id);
      return;
    }

    const attempts = row.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;

    await this.prisma.outboxMessage.update({
      where: { id: row.id },
      data: {
        status: dead ? 'DEAD' : 'PENDING',
        attempts,
        // Exponential backoff, capped at 5 minutes.
        availableAt: new Date(Date.now() + Math.min(2 ** attempts * 1000, 300_000)),
        lastError: String((failed[0] as PromiseRejectedResult).reason).slice(0, 500),
        ...(dead ? { publishedAt: null } : {}),
      },
    });

    this.metrics.counter('outbox_dispatch_failed_total').inc({
      event: envelope.eventType, dead: String(dead),
    });

    if (dead) {
      this.logger.error('outbox.message_dead', {
        id: String(row.id), event: envelope.eventType, correlationId: row.correlationId,
      });
    }
  }

  private async markPublished(id: bigint): Promise<void> {
    await this.prisma.outboxMessage.update({
      where: { id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
  }
}

export { OutboxHandler, OutboxPublisher };
