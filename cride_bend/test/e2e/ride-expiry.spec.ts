import { createTestApp, freezeRelay, resetDatabase, type TestApp } from '../fixtures/test-app';
import { acceptRide, registerActor, requestRide, type Actor } from '../fixtures/actors';
import { RideExpiryScheduler } from '../../src/rides/application/ride-expiry.scheduler';

const SWEEP_LOCK_KEY = 'ride-expiry:sweep-lock';

/**
 * §4.18 — ride expiry.
 *
 * This is the one write path in the system that nobody asked for. Every other
 * transition has a human on the other end of an HTTP request, which means a bug
 * shows up as a complaint from someone who was there. Expiry runs unattended, so
 * the failure modes worth testing are the ones where nothing is wrong *locally*:
 *
 *  - it cancels a ride a driver already took (the sweep read the row before the
 *    accept committed, and wrote anyway)
 *  - it cancels a fresh ride because the TTL was misread
 *  - two instances sweep at once and the rider gets cancelled twice
 *  - the lock is never released, and expiry quietly stops working forever
 *
 * The last one is why the release path is asserted directly rather than inferred
 * from "the second sweep worked" — an inferred pass would also be satisfied by a
 * lock that had simply expired.
 */
describe('§4.18 ride expiry', () => {
  let ctx: TestApp;
  let rider: Actor;
  let driver: Actor;
  let expiry: RideExpiryScheduler;

  beforeAll(async () => {
    ctx = await createTestApp();
    freezeRelay(ctx.app);
    // Resolvable from the container without RidesModule exporting it: app.get()
    // walks the whole graph. A test forcing an export purely for its own
    // convenience would be widening the module's public surface for no runtime
    // caller.
    expiry = ctx.app.get(RideExpiryScheduler);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma, ctx.redis);
    rider = await registerActor(ctx.http(), 'RIDER');
    driver = await registerActor(ctx.http(), 'DRIVER');
  });

  /** Backdates a ride past the offer window, as if it had been sitting there. */
  async function makeStale(rideId: string, minutes = 30): Promise<void> {
    await ctx.prisma.ride.update({
      where: { id: rideId },
      data: { createdAt: new Date(Date.now() - minutes * 60_000) },
    });
  }

  async function load(rideId: string) {
    return ctx.prisma.ride.findUniqueOrThrow({ where: { id: rideId } });
  }

  it('cancels a ride nobody took, attributed to SYSTEM', async () => {
    const ride = await requestRide(ctx.http(), rider);
    await makeStale(ride.id);

    const cancelled = await expiry.sweep();
    expect(cancelled).toBe(1);

    const row = await load(ride.id);
    expect(row.status).toBe('CANCELLED');
    // The attribution is the whole point. A rider reading this back later must be
    // able to tell an expiry from a cancellation they tapped.
    expect(row.cancelledBy).toBe('SYSTEM');
    expect(row.cancelReason).toMatch(/no driver accepted/i);
    // The version guard still applies to the machine, so a client holding the old
    // version learns its copy is stale instead of silently diverging.
    expect(row.version).toBe(ride.version + 1);
  });

  it('records the cancellation as a resyncable event with a SYSTEM actor', async () => {
    const ride = await requestRide(ctx.http(), rider);
    await makeStale(ride.id);
    await expiry.sweep();

    const events = await ctx.prisma.rideEvent.findMany({
      where: { rideId: ride.id },
      orderBy: { seq: 'asc' },
    });
    // Gapless, same as any other transition: 1 = requested, 2 = cancelled.
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    const cancellation = events[1]!;
    expect(cancellation.eventType).toBe('ride.cancelled');
    // No user pressed anything, so there is no user to point at.
    expect(cancellation.actorRole).toBe('SYSTEM');
    expect(cancellation.actorId).toBeNull();
  });

  it('emits an outbox row so the rider is still told', async () => {
    const ride = await requestRide(ctx.http(), rider);
    await makeStale(ride.id);
    await expiry.sweep();

    const outbox = await ctx.prisma.outboxMessage.findMany({ where: { aggregateId: ride.id } });
    // Without this the expiry would be silent: status changes in the database and
    // no notification ever leaves the system.
    expect(outbox.map((o) => o.eventType)).toContain('ride.cancelled');
  });

  it('leaves a ride inside the offer window alone', async () => {
    const ride = await requestRide(ctx.http(), rider);
    const cancelled = await expiry.sweep();
    expect(cancelled).toBe(0);
    expect((await load(ride.id)).status).toBe('REQUESTED');
  });

  it('leaves a ride that already has a driver alone', async () => {
    const ride = await requestRide(ctx.http(), rider);
    await acceptRide(ctx.http(), ride.id, driver);
    // A sweep that fires on schedule will eventually see accepted rides in its
    // query result set if the filter is wrong. This pins the filter.
    await makeStale(ride.id, 60);

    const cancelled = await expiry.sweep();
    expect(cancelled).toBe(0);
    expect((await load(ride.id)).status).toBe('ACCEPTED');
  });

  it('re-reads inside the transaction, so a ride accepted mid-sweep survives', async () => {
    const ride = await requestRide(ctx.http(), rider);
    await makeStale(ride.id);

    // The race, constructed precisely.
    //
    // Two orderings that both look right and both test nothing:
    //   - accepting *before* the sweep: the scan filters on `status: REQUESTED`,
    //     so the ride is never in the batch and the re-read is never reached
    //   - accepting *after* the sweep: nothing was racing at all
    //
    // The ride must therefore still be REQUESTED when findMany produces its
    // results, and only become ACCEPTED afterwards. `scanSaw` asserts the first
    // half, because a test that silently starts receiving an empty batch would
    // otherwise pass forever while proving nothing.
    const realFindMany = ctx.prisma.ride.findMany.bind(ctx.prisma.ride);
    let scanSaw: string[] = [];

    // The cast is confined to the spy: Prisma hands back a `PrismaPromise`, which
    // a bare `async` function cannot structurally reproduce, and reimplementing
    // that brand just to reorder one await is not worth it.
    const interleaved = (async (args: unknown) => {
      const rows = (await realFindMany(args as never)) as Array<{ id: string; status: string }>;
      scanSaw = rows.map((r) => `${r.id}:${r.status}`);
      // Committed now — after the scan produced its result set, before the
      // transaction runs. The state an `accept` leaves behind, applied directly.
      await ctx.prisma.ride.update({
        where: { id: ride.id },
        data: { status: 'ACCEPTED', version: { increment: 1 }, driverId: driver.id },
      });
      return rows;
    }) as unknown as typeof ctx.prisma.ride.findMany;

    const scanSpy = jest.spyOn(ctx.prisma.ride, 'findMany').mockImplementationOnce(interleaved);

    const cancelled = await expiry.sweep();
    scanSpy.mockRestore();

    // The scan saw it as REQUESTED; only the in-transaction re-read sees ACCEPTED.
    expect(scanSaw).toEqual([`${ride.id}:REQUESTED`]);
    expect(cancelled).toBe(0);
    expect((await load(ride.id)).status).toBe('ACCEPTED');
  });

  it('declines a ride it has just seen accepted, without attempting a write', async () => {
    // The assertion the test above cannot make on its own.
    //
    // "The ride is still ACCEPTED afterwards" is satisfied by two very different
    // mechanisms: the re-read guard returning null, or the guard being absent and
    // the write failing downstream and rolling back. Both leave an ACCEPTED row,
    // so the sweep-level assertion cannot tell them apart — and a test that
    // cannot tell them apart will keep passing after the guard is deleted.
    //
    // What separates them is whether the call *resolves* or *rejects*. A guard
    // declines politely and returns false; a missing guard throws whatever the
    // write layer throws and relies on the sweep's catch to swallow it. So this
    // asserts the resolved value directly, and asserts that nothing was written.
    const ride = await requestRide(ctx.http(), rider);
    await makeStale(ride.id);
    await acceptRide(ctx.http(), ride.id, driver);

    await expect(expiry.expireOne(ride.id, new Date(Date.now() + 1))).resolves.toBe(false);

    // No event, no outbox row, no version bump: the decline happened before any
    // write, not after a rolled-back one.
    expect(
      await ctx.prisma.rideEvent.count({ where: { rideId: ride.id, eventType: 'ride.cancelled' } }),
    ).toBe(0);
    const outboxTypes = await ctx.prisma.outboxMessage.findMany({
      where: { aggregateId: ride.id },
      orderBy: { id: 'asc' },
    });
    // The two an accept leaves behind, and no third.
    expect(outboxTypes.map((o) => o.eventType)).toEqual(['ride.requested', 'ride.accepted']);
    expect((await load(ride.id)).version).toBe(2);
    expect((await load(ride.id)).status).toBe('ACCEPTED');
  });

  it('is a no-op on a second sweep', async () => {
    const ride = await requestRide(ctx.http(), rider);
    await makeStale(ride.id);

    expect(await expiry.sweep()).toBe(1);
    // CANCELLED is terminal, so the sweep must not re-cancel or bump the version
    // again. A double cancel would show up as a duplicate notification and a
    // version gap that breaks client resync.
    expect(await expiry.sweep()).toBe(0);

    const row = await load(ride.id);
    expect(row.version).toBe(ride.version + 1);
    expect(
      await ctx.prisma.rideEvent.count({ where: { rideId: ride.id, eventType: 'ride.cancelled' } }),
    ).toBe(1);
  });

  it('keeps sweeping the rest of the batch when one ride is undatable', async () => {
    // Two riders, not two rides for one rider: a rider may hold only one active
    // ride, so a second request from `rider` would be a 409 and the test would be
    // measuring the wrong thing.
    const otherRider = await registerActor(ctx.http(), 'RIDER');
    const broken = await requestRide(ctx.http(), rider);
    const healthy = await requestRide(ctx.http(), otherRider);
    await makeStale(broken.id);
    await makeStale(healthy.id);

    // A sweep that aborts on the first error stops expiring rides entirely, and
    // the symptom is "expiry silently stopped working" rather than an alert.
    // Keyed to a specific ride rather than `mockRejectedValueOnce`, because the
    // scan has no `orderBy` and which ride lands first is not something to assert
    // on. The healthy ride delegates to the real implementation, so it is
    // genuinely cancelled rather than merely counted.
    const real = expiry.expireOne.bind(expiry);
    const spy = jest.spyOn(expiry, 'expireOne').mockImplementation(async (rideId, cutoff) => {
      if (rideId === broken.id) throw new Error('transient');
      return real(rideId, cutoff);
    });

    const cancelled = await expiry.sweep();
    expect(cancelled).toBe(1);
    expect((await load(healthy.id)).status).toBe('CANCELLED');
    expect((await load(broken.id)).status).toBe('REQUESTED');
    spy.mockRestore();
  });

  describe('the distributed lock', () => {
    it('refuses to sweep when another instance holds it', async () => {
      const ride = await requestRide(ctx.http(), rider);
      await makeStale(ride.id);

      await ctx.redis.client.set(SWEEP_LOCK_KEY, '99999', 'EX', 30);

      // Not an error: another instance is already doing exactly this work.
      expect(await expiry.sweepIfLeader()).toBe(0);
      // And crucially it did no work, not "lost the race and cancelled anyway".
      expect((await load(ride.id)).status).toBe('REQUESTED');
    });

    it('sweeps when it holds the lock', async () => {
      const ride = await requestRide(ctx.http(), rider);
      await makeStale(ride.id);
      expect(await expiry.sweepIfLeader()).toBe(1);
    });

    it('releases the lock afterwards', async () => {
      // Asserted on the key, not inferred from a second successful sweep: a
      // missing release and an expired TTL are indistinguishable from the outside,
      // and only the first one is a bug that stalls the feature indefinitely.
      await expiry.sweepIfLeader();
      expect(await ctx.redis.client.get(SWEEP_LOCK_KEY)).toBeNull();
    });

    it('releases the lock even when the sweep throws', async () => {
      const spy = jest.spyOn(expiry, 'sweep').mockRejectedValueOnce(new Error('db down'));
      await expect(expiry.sweepIfLeader()).rejects.toThrow('db down');
      expect(await ctx.redis.client.get(SWEEP_LOCK_KEY)).toBeNull();
      spy.mockRestore();
    });

    it('does not delete a lock that has already been taken by someone else', async () => {
      // The scenario is a lock that lapses *while we hold it*: our 30s TTL expires
      // mid-sweep, another instance acquires the key, and then our `finally` runs.
      // An unconditional DEL would free their lock and let two sweeps run at once.
      // The release is compare-and-delete for exactly this reason, and this is the
      // case that proves it.
      const spy = jest.spyOn(expiry, 'sweep').mockImplementationOnce(async () => {
        // Stand in for the TTL lapsing and a peer winning the race.
        await ctx.redis.client.set(SWEEP_LOCK_KEY, 'other-instance', 'EX', 30);
        throw new Error('db down');
      });

      await expect(expiry.sweepIfLeader(30)).rejects.toThrow('db down');
      // Their lock must survive our release.
      expect(await ctx.redis.client.get(SWEEP_LOCK_KEY)).toBe('other-instance');
      spy.mockRestore();
    });
  });
});
