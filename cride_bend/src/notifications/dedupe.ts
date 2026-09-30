import { Injectable } from '@nestjs/common';
import { CacheService } from '../platform/cache/cache.service';
import { PrismaService } from '../platform/prisma/prisma.service';

const DEDUPE_TTL_SECONDS = 86_400;

/** Notification idempotency. Redis SETNX is the fast path; the durable NotificationDelivery
 * row is the record, because if Redis flushes a naive implementation resends. */
@Injectable()
export class NotificationDedupe {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
  ) {}

  /** True if this delivery has not been attempted before. */
  async claim(dedupeKey: string, userId: string, rideId: string): Promise<boolean> {
    const fresh = await this.cache.acquireLock(`dedupe:${dedupeKey}`, DEDUPE_TTL_SECONDS * 1000, '1');
    if (fresh) return true;

    // Fall back to the durable record when Redis has lost the key.
    const existing = await this.prisma.notificationDelivery.findUnique({
      where: { dedupeKey },
      select: { status: true },
    });
    return !existing;
  }

  async recordSent(dedupeKey: string, userId: string, rideId: string): Promise<void> {
    await this.prisma.notificationDelivery.upsert({
      where: { dedupeKey },
      create: { dedupeKey, userId, rideId, status: 'SENT', attempts: 1, sentAt: new Date() },
      update: { status: 'SENT', attempts: { increment: 1 }, sentAt: new Date() },
    });
  }

  async recordFailed(dedupeKey: string, userId: string, rideId: string, reason: string): Promise<void> {
    await this.prisma.notificationDelivery.upsert({
      where: { dedupeKey },
      create: { dedupeKey, userId, rideId, status: 'FAILED', attempts: 1, failureReason: reason.slice(0, 300) },
      update: { status: 'FAILED', attempts: { increment: 1 }, failureReason: reason.slice(0, 300) },
    });
  }
}
