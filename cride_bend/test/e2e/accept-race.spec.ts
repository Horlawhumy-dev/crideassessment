import type { TestApp } from '../fixtures/test-app';
import { createTestApp, freezeRelay, resetDatabase } from '../fixtures/test-app';
import { acceptRide, registerActor, requestRide, type Actor } from '../fixtures/actors';
import { one } from '../fixtures/assert';

/**
 * §4.18 test 2 — "the highest-value test in the repository".
 *
 * Twenty distinct drivers fire `PATCH /rides/:id/accept` at the same ride at the
 * same instant. The assertions are deliberately about *database state*, not HTTP
 * status codes: a suite that only counted 200s and 409s would still pass if the
 * repository had been rewritten to SELECT-then-UPDATE, and that rewrite is exactly
 * the bug this exists to prevent.
 *
 * What is being proven at once:
 *   - §4.5.2  conditional update; a read cannot influence the outcome
 *   - §4.6    the outbox row is written in the same transaction as the state change
 *   - §4.5.4  the RideEvent stream is gapless and has exactly one accept event
 *   - §4.14.3 the database rejects a second driver, not merely the application
 */
describe('§4.18(2) the accept race', () => {
  const DRIVERS = 20;
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
    // This suite asserts on outbox and ride_event rows, so the 250ms poll must not
    // be able to dispatch a row between the write and the assertion.
    freezeRelay(ctx.app);
  });

  afterAll(async () => {
    // Defensive because a beforeAll that throws leaves ctx undefined, and the
    // teardown error would then mask the real failure with a confusing
    // "cannot read properties of undefined".
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma, ctx.redis);
  });

  it(`gives exactly one of ${DRIVERS} concurrent drivers the ride`, async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);

    const drivers: Actor[] = [];
    for (let i = 0; i < DRIVERS; i += 1) {
      drivers.push(await registerActor(ctx.http(), 'DRIVER'));
    }

    // All twenty in flight together. Promise.all over already-started requests is
    // what makes this a race rather than a sequence of quick successes; a loop of
    // awaits would prove nothing beyond "the first one wins".
    const results = await Promise.all(
      drivers.map(async (driver) => {
        const res = await ctx.http()
          .patch(`/rides/${ride.id}/accept`)
          .set('Authorization', driver.auth)
          .send({});
        return {
          driver,
          status: res.status,
          body: res.body as { error?: { code?: string } },
        };
      }),
    );

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(DRIVERS - 1);
    const winner = one(winners, `exactly one 200 among ${DRIVERS} concurrent accepts`);

    // A 409 has to be a *domain* conflict, not a generic failure. Anything else
    // — a 500, a 403, a 400 — would be a different bug wearing the same status.
    for (const loser of losers) {
      expect(loser.body.error?.code).toBe('RIDE_ALREADY_ACCEPTED');
    }

    // ---- the assertions that matter: what the database actually holds ----

    const stored = await ctx.prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });

    expect(stored.status).toBe('ACCEPTED');
    expect(stored.driverId).toBe(winner.driver.id);
    // The loser set and the winner set must not overlap, which is the whole point:
    // a row that took the winner's id *and* a 409 elsewhere would be a torn write.
    for (const loser of losers) {
      expect(loser.driver.id).not.toBe(stored.driverId);
    }

    expect(stored.version).toBe(2);
    expect(stored.acceptedAt).not.toBeNull();

    // One accept, and it is the driver's. If the outbox write were outside the
    // transaction, or the loser wrote a row anyway, this count would exceed one.
    const acceptedEvents = await ctx.prisma.rideEvent.findMany({
      where: { rideId: ride.id, eventType: 'ride.accepted' },
    });
    expect(acceptedEvents).toHaveLength(1);
    expect(one(acceptedEvents, 'exactly one ride.accepted event').actorId).toBe(stored.driverId);

    const outbox = await ctx.prisma.outboxMessage.findMany({ where: { aggregateId: ride.id } });
    expect(outbox.filter((m) => m.eventType === 'ride.accepted')).toHaveLength(1);

    // The whole stream, and it is gapless: seq 1 is ride.requested, seq 2 is
    // ride.accepted, and nothing else was written by nineteen failed attempts.
    const allEvents = await ctx.prisma.rideEvent.findMany({
      where: { rideId: ride.id },
      orderBy: { seq: 'asc' },
    });
    expect(allEvents.map((e) => e.seq)).toEqual([1, 2]);
    expect(allEvents.map((e) => e.eventType)).toEqual(['ride.requested', 'ride.accepted']);
  });

  it('reports RIDE_ALREADY_ACCEPTED to a driver who retries after losing', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);
    const first = await registerActor(ctx.http(), 'DRIVER');
    const second = await registerActor(ctx.http(), 'DRIVER');

    await acceptRide(ctx.http(), ride.id, first);

    const res = await ctx.http()
      .patch(`/rides/${ride.id}/accept`)
      .set('Authorization', second.auth)
      .send({})
      .expect(409);

    expect(res.body.error.code).toBe('RIDE_ALREADY_ACCEPTED');
  });

  it('refuses a rider accepting their own ride', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);

    const res = await ctx.http()
      .patch(`/rides/${ride.id}/accept`)
      .set('Authorization', rider.auth)
      .send({})
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('is decided by the database, not only by the application', async () => {
    // Proves the partial unique index from migration 0002 is really there and
    // really load-bearing. The application checks "does this rider have an active
    // ride" first, but that read is a check-then-act and is inherently racy; this
    // writes two active rides for one rider with no application code in the path.
    const rider = await registerActor(ctx.http(), 'RIDER');
    const driver = await registerActor(ctx.http(), 'DRIVER');

    const rideA = await requestRide(ctx.http(), rider);
    await acceptRide(ctx.http(), rideA.id, driver);

    // Prisma's P2002 message names the column, not the index, so the rejection is
    // asserted by error code. Asserting on the message text would have passed just
    // as well against a *plain* unique constraint on riderId, which is precisely
    // the wrong schema — it would forbid a rider's entire ride history.
    await expect(
      ctx.prisma.ride.create({
        data: {
          riderId: rider.id,
          status: 'REQUESTED',
          pickupLat: 37.7,
          pickupLng: -122.4,
          dropoffLat: 37.8,
          dropoffLng: -122.3,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // The index is PARTIAL. This is the assertion that distinguishes the intended
    // schema from the one the error message alone cannot rule out: terminal
    // states are excluded, so history accumulates freely.
    const [index] = await ctx.prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'rides' AND indexname = 'rides_one_active_per_rider'`,
    );
    expect(index).toBeDefined();
    expect(index?.indexdef).toContain('CREATE UNIQUE INDEX');
    // The predicate is the whole point of the index.
    expect(index?.indexdef).toMatch(/WHERE.*(REQUESTED|ACCEPTED|IN_PROGRESS)/s);

    // And the excluded terminal state really is insertable.
    await expect(
      ctx.prisma.ride.create({
        data: {
          riderId: rider.id,
          status: 'COMPLETED',
          driverId: driver.id,
          pickupLat: 37.7,
          pickupLng: -122.4,
          dropoffLat: 37.8,
          dropoffLng: -122.3,
        },
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a driver attached to a ride that is not ACCEPTED (CHECK constraint)', async () => {
    // §4.14.3's equivalence constraint: ACCEPTED-or-later iff a driver exists.
    // The application never produces this state, which is precisely why the
    // database has to forbid it.
    const rider = await registerActor(ctx.http(), 'RIDER');
    const driver = await registerActor(ctx.http(), 'DRIVER');
    const ride = await requestRide(ctx.http(), rider);

    await expect(
      ctx.prisma.ride.update({
        where: { id: ride.id },
        data: { driverId: driver.id },
      }),
    ).rejects.toThrow(/rides_driver_status_consistency/);
  });
});
