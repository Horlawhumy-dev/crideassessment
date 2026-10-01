import { Injectable } from '@nestjs/common';
import { asPrisma } from '../../platform/prisma/prisma-transaction.adapter';
import {
  OUTBOX_PORT,
  type OutboxEvent,
  type OutboxPort,
  type TransactionContext,
} from '../application/ports/outbox.port';

/** A plain PostgreSQL table written inside the ride transaction, not a queue: a queue cannot
 *  join that commit without a distributed transaction. The id is left to the database, since
 *  a client-chosen id can collide with the sequence at COMMIT. */
@Injectable()
export class PrismaOutboxAdapter implements OutboxPort {
  async enqueue(tx: TransactionContext, event: OutboxEvent): Promise<void> {
    await asPrisma(tx).outboxMessage.create({
      data: {
        eventType: event.type,
        aggregateId: event.aggregateId,
        seq: event.seq,
        correlationId: event.correlationId,
        payload: event.payload as object,
        status: 'PENDING',
        availableAt: new Date(),
      },
    });
  }
}

export { OUTBOX_PORT };
