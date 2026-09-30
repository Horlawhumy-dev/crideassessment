import { createTestApp, freezeRelay, resetDatabase, type TestApp } from '../fixtures/test-app';
import {
  acceptRide,
  completeRide,
  registerActor,
  requestRide,
  startRide,
  type Actor,
} from '../fixtures/actors';

/**
 * §4.18 test 1 — the state machine.
 *
 * The transition table is the part of this system most likely to be quietly
 * wrong, because every edge looks plausible in isolation: a driver who is slightly
 * ahead of the client might send IN_PROGRESS twice, a cancelled ride might be
 * revived by a retry, two drivers might both believe they are going to pick this
 * up. Each of those is a row a user can see.
 *
 * Two rules are under test and they are different in kind:
 *   - the table itself (§4.5.1) — which transitions are legal at all
 *   - the version guard (§4.5.2c) — that a legal transition still has to be the
 *     *next* one from the state the client last saw
 */
describe('§4.18(1) the ride state machine', () => {
  let ctx: TestApp;
  let rider: Actor;
  let driver: Actor;
  let other: Actor;

  beforeAll(async () => {
    ctx = await createTestApp();
    freezeRelay(ctx.app);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma, ctx.redis);
    rider = await registerActor(ctx.http(), 'RIDER');
    driver = await registerActor(ctx.http(), 'DRIVER');
    other = await registerActor(ctx.http(), 'DRIVER');
  });

  /** The legal path, as a baseline every rejection is compared against. */
  async function acceptedRide() {
    const ride = await requestRide(ctx.http(), rider);
    const accepted = await acceptRide(ctx.http(), ride.id, driver);
    return { ride, accepted, version: accepted.version };
  }

  async function transition(actor: Actor, rideId: string, to: string, version: number, reason?: string) {
    return ctx
      .http()
      .patch(`/rides/${rideId}/status`)
      .set('Authorization', actor.auth)
      .send({ to, version, ...(reason ? { reason } : {}) });
  }

  it('walks the happy path and records a gapless event stream', async () => {
    const ride = await requestRide(ctx.http(), rider);
    expect(ride.status).toBe('REQUESTED');

    const accepted = await acceptRide(ctx.http(), ride.id, driver);
    expect(accepted.status).toBe('ACCEPTED');

    const started = await startRide(ctx.http(), ride.id, driver, accepted.version);
    expect(started.status).toBe('IN_PROGRESS');

    const done = await completeRide(ctx.http(), ride.id, driver, started.version);
    expect(done.status).toBe('COMPLETED');

    // The version increments exactly once per transition, with no gaps. A client
    // that has applied version N knows the next one it is offered is N+1, which is
    // what makes its gap detection work.
    expect([ride.version, accepted.version, started.version, done.version]).toEqual([1, 2, 3, 4]);

    const events = await ctx.prisma.rideEvent.findMany({
      where: { rideId: ride.id },
      orderBy: { seq: 'asc' },
    });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => e.eventType)).toEqual([
      'ride.requested',
      'ride.accepted',
      'ride.started',
      'ride.completed',
    ]);

    // Timestamps are set by the transition that caused them and not before.
    expect(done.acceptedAt).not.toBeNull();
    expect(done.startedAt).not.toBeNull();
    expect(done.completedAt).not.toBeNull();
  });

  it('rejects every transition outside the table with INVALID_TRANSITION', async () => {
    const { ride, accepted } = await acceptedRide();

    // From ACCEPTED the only legal move is IN_PROGRESS. Completing from here is
    // the "client missed a frame" case.
    const skip = await transition(driver, ride.id, 'COMPLETED', accepted.version);
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('INVALID_TRANSITION');

    // The legal move, so it succeeds...
    const started = await transition(driver, ride.id, 'IN_PROGRESS', accepted.version);
    expect(started.status).toBe(200);

    // ...and repeating it is not. A driver whose client retried is the realistic
    // source, and the retry must be a refusal rather than a silent success.
    const repeat = await transition(driver, ride.id, 'IN_PROGRESS', started.body.version);
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('INVALID_TRANSITION');

    // A rider cannot drive their own ride, even one they are party to. The check
    // is role-based, so it is FORBIDDEN_ROLE rather than a visibility failure.
    const byRider = await transition(rider, ride.id, 'COMPLETED', started.body.version);
    expect(byRider.status).toBe(403);
    expect(byRider.body.error.code).toBe('FORBIDDEN_ROLE');

    // And none of the refusals moved anything.
    const stored = await ctx.prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(stored.status).toBe('IN_PROGRESS');
    expect(stored.version).toBe(started.body.version);
    expect(stored.completedAt).toBeNull();
  });

  it('does not let a rider cancel once a driver has committed', async () => {
    // §2 of the product doc: once a driver is en route, a rider may not cancel
    // unilaterally, because it strands them.
    //
    // The rule is now expressed in ride-policy rather than as a missing edge, and
    // the distinction matters. `ACCEPTED -> CANCELLED` exists; the *rider* is not
    // allowed along it, while the assigned driver is. Encoding a principal's
    // restriction by deleting a transition is indistinguishable from forgetting
    // the feature — which is exactly how the driver had no way to end a trip.
    const { ride, accepted } = await acceptedRide();

    const res = await transition(rider, ride.id, 'CANCELLED', accepted.version);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');

    // The same actor *can* cancel before acceptance, which is what makes the
    // restriction about commitment rather than about roles.
    //
    // A second rider, because the first still has an ACCEPTED ride and the
    // one-active-ride-per-rider index (migration 0002) correctly refuses to
    // create a second one. Asking `rider` to request again would 409 on the
    // index and test nothing about cancellation.
    const waiting = await registerActor(ctx.http(), 'RIDER');
    const fresh = await requestRide(ctx.http(), waiting);
    const early = await transition(waiting, fresh.id, 'CANCELLED', fresh.version);
    expect(early.status).toBe(200);
    expect(early.body.status).toBe('CANCELLED');
  });

  it('lets the assigned driver cancel, and keeps them on the ride', async () => {
    const { ride, accepted } = await acceptedRide();

    const res = await transition(driver, ride.id, 'CANCELLED', accepted.version, 'Vehicle broke down');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.cancelledBy).toBe('DRIVER');
    expect(res.body.cancelReason).toBe('Vehicle broke down');

    // driverId survives the cancellation. The assignment is a fact about the trip,
    // not something ending the trip should erase — and migration 0004 exists to
    // relax the CHECK constraint that used to forbid this exact row.
    const stored = await ctx.prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(stored.status).toBe('CANCELLED');
    expect(stored.cancelledBy).toBe('DRIVER');
    expect(stored.driverId).toBe(driver.id);
  });

  it('lets the driver cancel a trip already under way', async () => {
    const { ride, accepted } = await acceptedRide();
    const started = await startRide(ctx.http(), ride.id, driver, accepted.version);

    const res = await transition(driver, ride.id, 'CANCELLED', started.version);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.cancelledBy).toBe('DRIVER');
  });

  it('hides a ride from a driver who was never assigned, so offers cannot be weaponised', async () => {
    // `ride:offer` reaches every available driver. If an unassigned driver could
    // cancel, then "I saw this request" would be enough to end somebody's trip —
    // and a 403 rather than a 404 would confirm the ride exists while doing it.
    // `other` is registered as a DRIVER and never assigned, which is the case.
    const { ride, accepted } = await acceptedRide();

    const res = await transition(other, ride.id, 'CANCELLED', accepted.version);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RIDE_NOT_VISIBLE');

    const stored = await ctx.prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(stored.status).toBe('ACCEPTED');
  });

  it('treats a terminal state as terminal', async () => {
    const ride = await requestRide(ctx.http(), rider);

    // Cancelled before any driver was assigned.
    const cancelled = await transition(rider, ride.id, 'CANCELLED', ride.version);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    // Nothing revives it. A stale client still holding version 1 must not restart
    // a cancelled ride, and no late push may put it back in flight.
    //
    // Sent with the *current* version on purpose: passing the pre-cancel version
    // here would make every assertion in this loop about versioning rather than
    // terminality, and a version conflict is a different (equally correct) answer
    // that would mask the rule this test exists to pin down.
    for (const to of ['ACCEPTED', 'IN_PROGRESS', 'COMPLETED']) {
      const res = await transition(rider, ride.id, to, cancelled.body.version);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
    }

    // A driver cannot accept it either.
    const accept = await ctx
      .http()
      .patch(`/rides/${ride.id}/accept`)
      .set('Authorization', driver.auth)
      .send({});
    expect(accept.status).toBe(409);

    const stored = await ctx.prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(stored.status).toBe('CANCELLED');
    expect(stored.cancelledBy).toBe('RIDER');
    expect(stored.driverId).toBeNull();
  });

  it('treats a completed ride as terminal too', async () => {
    const { ride, accepted } = await acceptedRide();
    const started = await startRide(ctx.http(), ride.id, driver, accepted.version);
    const done = await completeRide(ctx.http(), ride.id, driver, started.version);
    expect(done.status).toBe('COMPLETED');

    for (const to of ['IN_PROGRESS', 'ACCEPTED', 'CANCELLED']) {
      const res = await transition(driver, ride.id, to, done.version);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
    }
  });

  it('enforces the version guard against a stale client', async () => {
    const { ride, accepted } = await acceptedRide();

    // Two clients holding version 2 both ask for IN_PROGRESS. The transition is
    // legal from ACCEPTED for both, so the table is not what separates them — the
    // conditional UPDATE is. Exactly one may win.
    const [a, b] = await Promise.all([
      transition(driver, ride.id, 'IN_PROGRESS', accepted.version),
      transition(driver, ride.id, 'IN_PROGRESS', accepted.version),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;

    expect(winner.body.version).toBe(accepted.version + 1);
    // RIDE_VERSION_CONFLICT, distinct from INVALID_TRANSITION: the move is legal,
    // the caller's *view* is stale. A client should re-fetch and retry on the
    // first, and give up on the second.
    expect(loser.body.error.code).toBe('RIDE_VERSION_CONFLICT');

    // Only one transition was recorded, so the loser did not double-apply.
    const started = await ctx.prisma.rideEvent.count({
      where: { rideId: ride.id, eventType: 'ride.started' },
    });
    expect(started).toBe(1);

    // A client more than one version behind is equally refused; there is no force
    // path and no "last write wins" escape hatch.
    const behind = await transition(driver, ride.id, 'COMPLETED', accepted.version);
    expect(behind.status).toBe(409);
  });

  it('keeps the driver and the ride in agreement about who may transition', async () => {
    const { ride, accepted } = await acceptedRide();

    // A driver with no connection to this ride is refused at the *visibility*
    // check, which runs first, so the answer is 404 RIDE_NOT_VISIBLE rather than
    // 403 NOT_ASSIGNED_DRIVER. Both are refusals; the ordering is what stops the
    // endpoint from confirming that the ride id exists.
    const stranger = await transition(other, ride.id, 'IN_PROGRESS', accepted.version);
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe('RIDE_NOT_VISIBLE');

    // Only the assigned driver may move an accepted ride onward.
    const asDriver = await transition(driver, ride.id, 'IN_PROGRESS', accepted.version);
    expect(asDriver.status).toBe(200);
  });

  it('rejects a transition on a ride that does not exist', async () => {
    const res = await transition(driver, '00000000-0000-4000-8000-000000000000', 'IN_PROGRESS', 1);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RIDE_NOT_FOUND');
  });

  it('reports a stale version as a version conflict', async () => {
    // The two 409s are distinct on purpose: INVALID_TRANSITION means "that move
    // is not in the table", RIDE_VERSION_CONFLICT means "that move is legal but
    // from a state you have not seen". A client recovering from the second should
    // re-fetch and retry; from the first it should not.
    const { ride, accepted } = await acceptedRide();
    const started = await transition(driver, ride.id, 'IN_PROGRESS', accepted.version);
    expect(started.status).toBe(200);

    // A client still holding the pre-IN_PROGRESS version tries to start again.
    const stale = await transition(driver, ride.id, 'IN_PROGRESS', accepted.version);
    expect(stale.status).toBe(409);
  });

  it('requires authentication and role for every state-changing call', async () => {
    const ride = await requestRide(ctx.http(), rider);

    const anon = await ctx
      .http()
      .patch(`/rides/${ride.id}/status`)
      .send({ to: 'CANCELLED', version: 1 });
    expect(anon.status).toBe(401);

    // Authenticated but unrelated: 404, because visibility is checked before role.
    const wrongRole = await transition(other, ride.id, 'CANCELLED', ride.version);
    expect(wrongRole.status).toBe(404);
    expect(wrongRole.body.error.code).toBe('RIDE_NOT_VISIBLE');

    // Authenticated, related, wrong role: the rider may cancel from REQUESTED.
    const asRider = await transition(rider, ride.id, 'IN_PROGRESS', ride.version);
    expect(asRider.status).toBe(403);
    expect(asRider.body.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('does not expose a ride to a principal who is not a party to it', async () => {
    const ride = await requestRide(ctx.http(), rider);

    // 404 rather than 403: a 403 would confirm the id exists and turn the detail
    // endpoint into an enumeration oracle.
    const res = await ctx
      .http()
      .get(`/rides/${ride.id}`)
      .set('Authorization', other.auth);

    expect(res.status).toBe(404);
    // RIDE_NOT_VISIBLE, not RIDE_NOT_FOUND: the distinction is deliberate, since a
    // 403-shaped answer would confirm the id exists. Both are 404 on the wire; the
    // code tells an operator whether the ride is missing or merely private.
    expect(res.body.error.code).toBe('RIDE_NOT_VISIBLE');
  });
});
