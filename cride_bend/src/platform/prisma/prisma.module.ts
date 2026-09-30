import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PrismaTransactionAdapter } from './prisma-transaction.adapter';
import { TRANSACTION_RUNNER } from '../../kernel/transaction';

@Global()
@Module({
  providers: [PrismaService, PrismaTransactionAdapter, { provide: TRANSACTION_RUNNER, useExisting: PrismaTransactionAdapter }],
  exports: [PrismaService, TRANSACTION_RUNNER],
})
export class PrismaModule {}
