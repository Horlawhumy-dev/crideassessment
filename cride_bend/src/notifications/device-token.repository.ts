import { Injectable } from '@nestjs/common';
import { PrismaService } from '../platform/prisma/prisma.service';

export const DEVICE_TOKEN_REPOSITORY = Symbol('DEVICE_TOKEN_REPOSITORY');

/** Resolving a user id to a live push target. Returns only tokens that are not revoked: a
 * revoked token is one FCM has already called dead, and sending to it burns a delivery
 * attempt and reproduces the permanent-failure loop this table exists to end. */
export interface DeviceTokenRepository {  activeTokensFor(userIds: readonly string[]): Promise<Map<string, string[]>>;
  revoke(token: string): Promise<void>;
  register(input: { userId: string; token: string; platform: string }): Promise<void>;
  revokeAllFor(userId: string): Promise<number>;
  listFor(userId: string): Promise<DeviceTokenView[]>;
}

export interface DeviceTokenView {
  readonly token: string;
  readonly platform: string;
  readonly createdAt: Date;
}

@Injectable()
export class PrismaDeviceTokenRepository implements DeviceTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registering is an upsert that *clears* the revoked marker. The row is kept rather than
   * deleted on revoke, so a client presenting the same token revives it instead of colliding
   * with a unique index.
   */
  async register(input: { userId: string; token: string; platform: string }): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token: input.token },
      create: { userId: input.userId, token: input.token, platform: input.platform },
      update: { userId: input.userId, platform: input.platform, revokedAt: null },
    });
  }

  async revokeAllFor(userId: string): Promise<number> {
    const { count } = await this.prisma.deviceToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  async listFor(userId: string): Promise<DeviceTokenView[]> {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId, revokedAt: null },
      select: { token: true, platform: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows;
  }

  async activeTokensFor(userIds: readonly string[]): Promise<Map<string, string[]>> {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId: { in: [...userIds] }, revokedAt: null },
      select: { userId: true, token: true },
    });

    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const list = grouped.get(row.userId) ?? [];
      list.push(row.token);
      grouped.set(row.userId, list);
    }
    return grouped;
  }

  async revoke(token: string): Promise<void> {
    // Keep the row and mark it: the token itself is the unique key, and a delete would let
    // a client resurrect a dead install on its next register call.
    await this.prisma.deviceToken.updateMany({
      where: { token, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
