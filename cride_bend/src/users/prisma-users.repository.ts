import { Injectable } from '@nestjs/common';
import { PrismaService } from '../platform/prisma/prisma.service';
import type { CreateUserInput, UserRecord, UsersRepository } from './users.repository';

/** The only file above the infrastructure layer allowed to know Prisma exists. */
@Injectable()
export class PrismaUsersRepository implements UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { id } }).then((u) => (u ? toRecord(u) : null));
  }

  async findByEmail(email: string): Promise<(UserRecord & { passwordHash: string }) | null> {
    const u = await this.prisma.user.findUnique({ where: { email: normalise(email) } });
    if (!u) return null;
    return { ...toRecord(u), passwordHash: u.passwordHash };
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const u = await this.prisma.user.create({
      data: { ...input, email: normalise(input.email) },
    });
    return toRecord(u);
  }

  async existsByEmail(email: string): Promise<boolean> {
    const count = await this.prisma.user.count({ where: { email: normalise(email) } });
    return count > 0;
  }

  async setAvailability(id: string, isAvailable: boolean): Promise<UserRecord | null> {
    const u = await this.prisma.user.update({ where: { id }, data: { isAvailable } });
    return toRecord(u);
  }
}

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

type UserRow = Awaited<ReturnType<PrismaService['user']['findUnique']>> & object;

function toRecord(u: UserRow): UserRecord {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName ?? u.email,
    role: u.role as 'RIDER' | 'DRIVER',
    phone: u.phone ?? null,
    isAvailable: u.isAvailable ?? false,
    fcmEnabled: u.fcmToken !== null && u.fcmToken !== undefined,
    createdAt: u.createdAt,
  };
}
