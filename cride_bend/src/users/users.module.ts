import { Module } from '@nestjs/common';
import { PrismaUsersRepository } from './prisma-users.repository';
import { USERS_REPOSITORY } from './users.repository';

@Module({
  providers: [{ provide: USERS_REPOSITORY, useClass: PrismaUsersRepository }],
  exports: [USERS_REPOSITORY],
})
export class UsersModule {}
