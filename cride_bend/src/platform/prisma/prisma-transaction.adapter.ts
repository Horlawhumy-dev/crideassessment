import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { TRANSACTION_RUNNER, type TransactionContext, type TransactionRunner } from '../../kernel/transaction';

/** The Prisma implementation of the transaction port: the only place allowed to know that
 * `tx` is a Prisma transaction client. */
@Injectable()
export class PrismaTransactionAdapter implements TransactionRunner {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    // ReadCommitted is Prisma's default and the right level: the ride paths rely on
    // row-level conditional updates (UPDATE ... WHERE status = ...) for correctness, not
    // on multi-statement snapshot isolation.
    return this.prisma.$transaction(fn as (tx: Prisma.TransactionClient) => Promise<T>, {
      isolationLevel: 'ReadCommitted',
      // Bounded so a stuck lock cannot hold connections open until the pool exhausts.
      // A ride write is single-digit milliseconds; anything near this is a bug.
      timeout: 5_000,
      maxWait: 2_000,
    });
  }
}

/** The one sanctioned cast from the opaque context to a Prisma client. */
export function asPrisma(tx: TransactionContext): Prisma.TransactionClient {
  return tx as Prisma.TransactionClient;
}

export { TRANSACTION_RUNNER };
