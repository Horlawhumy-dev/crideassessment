import { Injectable } from '@nestjs/common';
import { InAppNotificationKind } from '@prisma/client';

import { pageOf, type Page, type PageCursor } from '../kernel/page-cursor';
import { PrismaService } from '../platform/prisma/prisma.service';

export const IN_APP_NOTIFICATION_REPOSITORY = Symbol('IN_APP_NOTIFICATION_REPOSITORY');

export interface NewInAppNotification {
  readonly dedupeKey: string;
  readonly userId: string;
  readonly rideId: string;
  readonly kind: InAppNotificationKind;
  readonly title: string;
  readonly body: string;
}

export interface InAppNotificationRecord {
  readonly id: string;
  readonly dedupeKey: string;
  readonly userId: string;
  readonly rideId: string;
  readonly kind: InAppNotificationKind;
  readonly title: string;
  readonly body: string;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface InAppListFilter {
  readonly unreadOnly: boolean;
  readonly cursor: PageCursor | null;
  readonly limit: number;
}

export interface InAppMarkReadResult {
  /** False when the entry was already read, so this call did not stamp it. */
  readonly changed: boolean;
  /** The moment it was *first* marked read. Never moved by a second call. */
  readonly readAt: Date;
}

/** The inbox's only storage interface. A port because the write path runs from the outbox
 * relay and the read path from a controller, and neither should know the rows are Prisma. */
export interface InAppNotificationRepository {
  /** Returns how many rows were actually inserted; a replay inserts none. */
  recordAll(rows: readonly NewInAppNotification[]): Promise<number>;
  listFor(userId: string, filter: InAppListFilter): Promise<Page<InAppNotificationRecord>>;
  countUnread(userId: string): Promise<number>;
  /** `null` covers both an id that does not exist and one belonging to somebody else,
   * indistinguishably, so this cannot confirm that an id exists in another inbox. */
  markRead(userId: string, id: string): Promise<InAppMarkReadResult | null>;
  markAllRead(userId: string): Promise<number>;
}

@Injectable()
export class PrismaInAppNotificationRepository implements InAppNotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `createMany` with `skipDuplicates` rather than a loop of `upsert`s: one round trip, no
   * read-modify-write a concurrent replay could interleave with. The durable row *is* the
   * claim — a second insert of the same (ride, seq, recipient) violates a unique index, so a
   * relay replay is a no-op rather than a second row.
   */
  async recordAll(rows: readonly NewInAppNotification[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await this.prisma.inAppNotification.createMany({
      data: rows.map((row) => ({ ...row })),
      skipDuplicates: true,
    });
    return count;
  }

  /**
   * Keyset-paginated on (createdAt DESC, id): an inbox grows forever, and an offset would
   * skip or repeat rows the moment a new notification arrives mid-scroll. The cursor is
   * `createdAt < c OR (createdAt = c AND id < c.id)` rather than a tuple comparison — both
   * correct in Postgres, but only the disjunction is guaranteed to use the
   * (userId, readAt, createdAt DESC) index instead of sorting the rest.
   */
  async listFor(userId: string, filter: InAppListFilter): Promise<Page<InAppNotificationRecord>> {
    const rows = await this.prisma.inAppNotification.findMany({
      where: {
        userId,
        ...(filter.unreadOnly ? { readAt: null } : {}),
        ...(filter.cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(filter.cursor.createdAt) } },
                { createdAt: new Date(filter.cursor.createdAt), id: { lt: filter.cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One over the limit, because `pageOf` decides `hasMore` from the overflow.
      take: filter.limit + 1,
    });

    return pageOf(rows, filter.limit, (row) => ({
      createdAt: row.createdAt.toISOString(),
      id: row.id,
    }));
  }

  async countUnread(userId: string): Promise<number> {
    return this.prisma.inAppNotification.count({ where: { userId, readAt: null } });
  }

  /**
   * `updateMany` on `{id, userId, readAt: null}` rather than `update` on the id: an entry
   * that is not the caller's is a miss, not a permission error, and the `readAt: null`
   * predicate makes a second mark a no-op that returns the ORIGINAL `readAt` instead of
   * moving the timestamp. It also settles concurrent tabs without a lock.
   */
  async markRead(userId: string, id: string): Promise<InAppMarkReadResult | null> {
    const readAt = new Date();

    const { count } = await this.prisma.inAppNotification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt },
    });
    if (count > 0) return { changed: true, readAt };

    const existing = await this.prisma.inAppNotification.findFirst({
      where: { id, userId },
      select: { readAt: true },
    });
    if (!existing?.readAt) return null;

    return { changed: false, readAt: existing.readAt };
  }

  async markAllRead(userId: string): Promise<number> {
    const { count } = await this.prisma.inAppNotification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }
}