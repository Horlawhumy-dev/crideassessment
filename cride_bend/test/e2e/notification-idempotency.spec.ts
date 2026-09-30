import { Queue } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { createTestApp, freezeRelay, resetDatabase, type TestApp } from '../fixtures/test-app';
import { acceptRide, registerActor, requestRide } from '../fixtures/actors';
import { first } from '../fixtures/assert';
import { QUEUE_RIDE_NOTIFICATIONS } from '../../src/platform/queue/queues';
import { OutboxRelay } from '../../src/outbox/outbox.relay';

/**
 * §4.18 test 3 — notification delivery.
 *
 * The relay is at-least-once by construction (§4.6: FOR UPDATE SKIP LOCKED, a
 * crashed relay's rows released by rollback rather than delivered exactly once).
 * So the same outbox row is expected to be dispatched more than once — a relay that
 * dies between "handled" and "marked PUBLISHED" is a normal event, not a bug — and
 * a rider who receives four push notifications for one accepted ride is the
 * user-visible symptom.
 *
 * This test found a live bug while being written. `QueueProducer` was formatting
 * jobIds with ':' separators, which BullMQ rejects outright ("Custom Id cannot
 * contain :"), so every enqueue in the system failed. Worse, `QueueProducer.send`
 * caught and logged that failure, and `OutboxRelay.dispatch` chooses between
 * PUBLISHED and retry solely on whether the handler rejected — so the row was
 * marked PUBLISHED despite the enqueue never having happened, and the retry ladder,
 * the DEAD state and the `lastError` column were all unreachable. `ride.requested`
 * and `ride.accepted` notifications were being silently dropped in production.
 */
describe('§4.18(3) notification delivery', () => {
  let ctx: TestApp;
  let queue: Queue;
  let relay: OutboxRelay;

  /**
   * A handler that can be told to fail, and is a harmless no-op otherwise.
   *
   * The relay's `publishers` set is private, and reaching into it from a test
   * would be both untypable and a lie about the API. It does expose `register()`,
   * but it has no `unregister()`, so registering per test would permanently
   * accumulate handlers and corrupt every test after the first. A single
   * registered handler with a mutable `armed` flag gives each test its own failure
   * without touching production code to make tests possible.
   */
  const sabotage = { armed: false };
  const togglableFailure = {
    canHandle: () => true,
    handle: async () => {
      if (sabotage.armed) throw new Error('FCM unreachable');
    },
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    queue = ctx.moduleRef.get<Queue>(getQueueToken(QUEUE_RIDE_NOTIFICATIONS));
    relay = ctx.moduleRef.get(OutboxRelay);
    relay.register(togglableFailure);
    // Drained explicitly via drainOnce() in each test, so the 250ms poll has to be
    // off or the attempt counts would advance on their own.
    freezeRelay(ctx.app);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await ctx?.close();
  });

  beforeEach(async () => {
    sabotage.armed = false;
    await resetDatabase(ctx.prisma, ctx.redis);
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  /** Drains the relay synchronously so assertions are not racing a 250ms poll. */
  async function drain(): Promise<number> {
    return relay.drainOnce();
  }

  it('enqueues exactly one job per outbox message', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    await requestRide(ctx.http(), rider);

    expect(await drain()).toBeGreaterThan(0);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    const requested = jobs.filter((j) => j.name === 'ride.requested');

    expect(requested).toHaveLength(1);
    expect(requested[0]?.id).not.toContain(':');
  });

  it('delivers the same envelope once when the relay is driven repeatedly', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const driver = await registerActor(ctx.http(), 'DRIVER');
    const ride = await requestRide(ctx.http(), rider);
    await acceptRide(ctx.http(), ride.id, driver);

    await drain();

    const afterFirst = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    const acceptedAfterFirst = afterFirst.filter((j) => j.name === 'ride.accepted');
    expect(acceptedAfterFirst).toHaveLength(1);

    // Force the redelivery the at-least-once design promises: rewind every
    // published row to PENDING with its attempt count intact, which is exactly
    // the state a relay crash mid-dispatch leaves behind.
    await ctx.prisma.outboxMessage.updateMany({
      where: { aggregateId: ride.id },
      data: { status: 'PENDING', attempts: 1 },
    });

    await drain();
    await drain();

    const afterReplays = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    const acceptedAfterReplays = afterReplays.filter((j) => j.name === 'ride.accepted');

    // The point of the test. A rider must not be told four times that their ride
    // was accepted.
    expect(acceptedAfterReplays).toHaveLength(1);
  });

  it('builds a jobId that is a pure function of the envelope', async () => {
    // Guards the property the dedupe depends on: same envelope in, same key out.
    // A jobId that varied per attempt would defeat the idempotency entirely while
    // still looking correct in the queue-count assertions above.
    const rider = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);

    await drain();

    const job = first(
      (await queue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter(
        (j) => j.name === 'ride.requested',
      ),
      'a ride.requested job',
    );

    await ctx.prisma.outboxMessage.updateMany({
      where: { aggregateId: ride.id },
      data: { status: 'PENDING' },
    });
    await drain();

    const replayed = (await queue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter(
      (j) => j.name === 'ride.requested',
    );

    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.id).toBe(job.id);
  });

  it('retries a failed dispatch instead of marking it PUBLISHED', async () => {
    // The regression test for the swallowed error. A handler that throws must
    // leave the row PENDING with an incremented attempt count and a recorded
    // error, because that is the only signal the operator gets.
    const rider = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);

    sabotage.armed = true;
    await drain();

    const row = await ctx.prisma.outboxMessage.findFirstOrThrow({
      where: { aggregateId: ride.id },
    });

    // PUBLISHED here would mean a message that was never sent is recorded as
    // sent, and nothing would ever look for it again.
    expect(row.status).not.toBe('PUBLISHED');
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('FCM unreachable');
    // Backoff must be in the future, or the relay hot-loops on a broken FCM.
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives up after the attempt ceiling and marks the row DEAD', async () => {
    // A permanently broken destination must not retry forever. DEAD plus a
    // preserved lastError is the operator's only handle on the lost notification.
    const rider = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);

    sabotage.armed = true;

    // MAX_ATTEMPTS is 8 in the relay; each drain bumps attempts by one. The
    // availableAt reset is the test standing in for the passing of real time —
    // without it the exponential backoff would keep every row in the future and
    // the ladder would never advance.
    for (let i = 0; i < 8; i += 1) {
      await ctx.prisma.outboxMessage.updateMany({
        where: { aggregateId: ride.id },
        data: { availableAt: new Date(0) },
      });
      await drain();
    }

    const row = await ctx.prisma.outboxMessage.findFirstOrThrow({
      where: { aggregateId: ride.id },
    });

    expect(row.status).toBe('DEAD');
    expect(row.attempts).toBe(8);
    // The reason must survive, otherwise DEAD is just silent loss with a label.
    expect(row.lastError).toContain('FCM unreachable');
  });
});
