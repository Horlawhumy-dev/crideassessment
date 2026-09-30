import { OutboxRelay } from './outbox.relay';
import type { OutboxEnvelope, OutboxPublisher } from './outbox.publisher';
import type { PrismaService } from '../platform/prisma/prisma.service';
import { MetricsService } from '../platform/otel/metrics';

/**
 * At-least-once is deliberate, and only safe because handlers are idempotent. These pin
 * the three behaviours that follow: a crashed handler is retried, a permanently failing
 * handler is quarantined, and a message with no subscriber is still marked done.
 */
interface Row {
  id: bigint;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  seq: number | null;
  correlationId: string;
  attempts: number;
  createdAt: Date;
  status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'DEAD';
  availableAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
}

class FakePrisma {
  rows: Row[] = [];
  readonly updates: Array<{ id: bigint; data: Partial<Row> }> = [];

  readonly outboxMessage = {
    findMany: async () =>
      this.rows.filter((r) => r.status === 'PENDING' && r.availableAt <= new Date()),

    updateMany: async (args: { where: { id: { in: bigint[] } } }) => {
      for (const id of args.where.id.in) {
        const row = this.rows.find((r) => r.id === id);
        if (row) row.status = 'PROCESSING';
      }
      return { count: args.where.id.in.length };
    },

    update: async (args: { where: { id: bigint }; data: Partial<Row> }) => {
      this.updates.push({ id: args.where.id, data: args.data });
      const row = this.rows.find((r) => r.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return row;
    },
  };

  /** The callback receives this instance as the transaction handle, which is what Prisma
   * does — so the claim and its update commit together. */
  $transaction = <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => Promise.resolve(fn(this));
}

function relayWith(prisma: FakePrisma) {
  return new OutboxRelay(prisma as unknown as PrismaService, new MetricsService());
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 1n,
    eventType: 'ride.accepted',
    aggregateId: 'ride-1',
    payload: { riderId: 'rider-1', driverId: 'driver-1' },
    seq: 2,
    correlationId: 'corr-1',
    attempts: 0,
    createdAt: new Date(Date.now() - 1000),
    status: 'PENDING',
    availableAt: new Date(0),
    publishedAt: null,
    lastError: null,
    ...overrides,
  };
}

class RecordingHandler implements OutboxPublisher {
  readonly seen: OutboxEnvelope[] = [];
  constructor(
    private readonly name: string,
    private readonly failTimes = 0,
  ) {}
  canHandle(): boolean {
    return true;
  }
  async handle(envelope: OutboxEnvelope): Promise<void> {
    this.seen.push(envelope);
    if (this.seen.length <= this.failTimes) {
      throw new Error(`${this.name} down`);
    }
  }
}

describe('OutboxRelay', () => {
  it('marks a message published once every handler succeeds', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [row()];
    const relay = relayWith(prisma);
    const handler = new RecordingHandler('realtime');
    relay.register(handler);

    const drained = await relay.drainOnce();

    expect(drained).toBe(1);
    expect(handler.seen).toHaveLength(1);
    expect(prisma.updates.at(-1)?.data.status).toBe('PUBLISHED');
  });

  it('carries the correlation id through to the handler', async () => {
    // Without this, "why did this accept take 1.8s" cannot be answered from the logs.
    const prisma = new FakePrisma();
    prisma.rows = [row()];
    const relay = relayWith(prisma);
    const handler = new RecordingHandler('realtime');
    relay.register(handler);

    await relay.drainOnce();

    expect(handler.seen[0]?.correlationId).toBe('corr-1');
    expect(handler.seen[0]?.aggregateId).toBe('ride-1');
  });

  it('retries a failed message with exponential backoff instead of losing it', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [row()];
    const relay = relayWith(prisma);
    relay.register(new RecordingHandler('realtime', 1));

    await relay.drainOnce();

    const update = prisma.updates.at(-1);
    expect(update?.data.status).toBe('PENDING');
    expect(update?.data.attempts).toBe(1);
    // Pushed into the future, or an immediate retry would hot-loop.
    expect(update?.data.availableAt).toBeInstanceOf(Date);
    expect((update?.data.availableAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(update?.data.lastError).toContain('down');
  });

  it('quarantines a message that keeps failing, and keeps it for inspection', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [row({ attempts: 7 })];
    const relay = relayWith(prisma);
    relay.register(new RecordingHandler('realtime', 99));

    await relay.drainOnce();

    const update = prisma.updates.at(-1);
    expect(update?.data.status).toBe('DEAD');
    expect(update?.data.attempts).toBe(8);
    // Retained rather than deleted: "which ride never got its notification" has to
    // be answerable after the fact.
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]?.lastError).toContain('down');
  });

  it('fans out to every interested handler', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [row()];
    const relay = relayWith(prisma);
    const realtime = new RecordingHandler('realtime');
    const notifications = new RecordingHandler('notifications');
    relay.register(realtime);
    relay.register(notifications);

    await relay.drainOnce();

    expect(realtime.seen).toHaveLength(1);
    expect(notifications.seen).toHaveLength(1);
  });

  it('does not publish until every handler has succeeded', async () => {
    // Partial delivery is worse than a retry: the rider gets a push while the socket
    // update is silently missing, and nothing ever repairs it.
    const prisma = new FakePrisma();
    prisma.rows = [row()];
    const relay = relayWith(prisma);
    const realtime = new RecordingHandler('realtime');
    const notifications = new RecordingHandler('notifications', 99);
    relay.register(realtime);
    relay.register(notifications);

    await relay.drainOnce();

    expect(realtime.seen).toHaveLength(1);
    expect(prisma.updates.at(-1)?.data.status).toBe('PENDING');
  });

  it('marks a message done when nothing handles it, so the queue cannot wedge', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [row({ eventType: 'ride.started' })];
    const relay = relayWith(prisma);
    relay.register(new RecordingHandler('realtime', 0));
    // A handler that opts out of this event type, as the notification handler
    // does for driver-offer events.
    const uninterested: OutboxPublisher = {
      canHandle: (eventType) => eventType !== 'ride.started',
      handle: async () => undefined,
    };
    relay.register(uninterested);

    await relay.drainOnce();

    expect(prisma.updates.at(-1)?.data.status).toBe('PUBLISHED');
  });

  it('processes a batch independently, so one poison message does not block the rest', async () => {
    // Row 2 is one attempt from the limit; rows 1 and 3 are fresh. If a failure
    // aborted the batch, rows 1 and 3 would be left in PROCESSING forever and the
    // queue would stall behind a single bad message.
    const prisma = new FakePrisma();
    prisma.rows = [row({ id: 1n }), row({ id: 2n, attempts: 7 }), row({ id: 3n })];
    const relay = relayWith(prisma);
    const handler = new RecordingHandler('realtime', 99);
    relay.register(handler);

    await relay.drainOnce();

    // Every row was attempted, i.e. the throw was contained per message.
    expect(handler.seen.map((e) => e.aggregateId)).toHaveLength(3);

    const byId = new Map(prisma.updates.map((u) => [u.id, u.data.status]));
    expect(byId.get(2n)).toBe('DEAD');
    expect(byId.get(1n)).toBe('PENDING');
    expect(byId.get(3n)).toBe('PENDING');
  });

  it('is a no-op when there is nothing to do', async () => {
    const relay = relayWith(new FakePrisma());
    await expect(relay.drainOnce()).resolves.toBe(0);
  });
});
