import { Injectable } from '@nestjs/common';
import { PrismaService } from '../platform/prisma/prisma.service';
import { hashToken, type SessionStore } from './session.port';

/** The only file in auth/ that may import Prisma. */
@Injectable()
export class PrismaSessionRepository implements SessionStore {
  constructor(private readonly prisma: PrismaService) {}

  async issue(input: { userId: string; familyId: string; token: string; expiresAt: Date }): Promise<void> {
    await this.prisma.refreshToken.create({
      data: {
        userId: input.userId,
        familyId: input.familyId,
        tokenHash: hashToken(input.token),
        expiresAt: input.expiresAt,
      },
    });
  }

  async consume(token: string): Promise<{ userId: string; familyId: string } | 'REPLAYED' | null> {
    const tokenHash = hashToken(token);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (!row) return null;

      if (row.revokedAt) return null;
      if (row.expiresAt.getTime() < Date.now()) return null;

      if (row.usedAt !== null) {
        // A token that already rotated is a replay: burn the whole family before returning.
        await tx.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return 'REPLAYED';
      }

      // `usedAt: null` in the where clause is the lock: two concurrent refreshes
      // cannot both claim, so the loser is caught as a replay instead of both winning.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: row.id, usedAt: null, revokedAt: null },
        data: { usedAt: new Date() },
      });

      if (claimed.count === 0) {
        await tx.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return 'REPLAYED';
      }

      return { userId: row.userId, familyId: row.familyId };
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeSessionUserTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
