import { createTestApp, resetDatabase, type TestApp } from '../fixtures/test-app';
import { acceptRide, registerActor, requestRide, startRide } from '../fixtures/actors';
import { ack, connectRideSocket, type RideSocket } from '../fixtures/socket';

/**
 * §4.18 test 4 — socket resync.
 *
 * A phone loses signal in a tunnel. The ride does not stop; the driver keeps
 * driving, the rider keeps waiting, and events the phone never saw still exist in
 * the `ride_events` table. The question this test answers is the one a user
 * actually experiences: when the phone reconnects, can it tell what it missed and
 * repair itself without a full refetch?
 *
 * The failure mode being guarded against is a gateway that assumes the client's
 * view is current. It would return an empty event list, the client would render
 * `REQUESTED` on a ride that is `IN_PROGRESS`, and the rider would be watching a
 * stale trip with no indication anything was wrong.
 */
describe('§4.18(4) socket resync', () => {
  let ctx: TestApp;
  const open: RideSocket[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await Promise.all(open.map((s) => s.disconnect()));
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma, ctx.redis);
  });

  /** Tracked for teardown; a leaked socket holds a handle and hangs the run. */
  async function connect(token: string): Promise<RideSocket> {
    const s = await connectRideSocket(ctx.url, token);
    open.push(s);
    return s;
  }

  it('replays only the events a reconnecting client missed', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const driver = await registerActor(ctx.http(), 'DRIVER');
    const ride = await requestRide(ctx.http(), rider);

    const before = await connect(rider.accessToken);
    await ack(before.socket, 'ride:join', { rideId: ride.id, lastSeq: 0 });

    const accepted = await acceptRide(ctx.http(), ride.id, driver);
    await startRide(ctx.http(), ride.id, driver, accepted.version);

    // The phone dies here. It saw `requested`, nothing else.
    await before.disconnect();
    open.length = 0;

    // The ride keeps moving while nobody is listening.
    await ctx.prisma.ride.update({
      where: { id: ride.id },
      data: { status: 'IN_PROGRESS' },
    });

    const after = await connect(rider.accessToken);
    const snapshot = await ack<{ ride: { status: string; version: number }; events: { seq: number; eventType: string }[]; lastSeq: number }>(
      after.socket,
      'ride:sync',
      { rideId: ride.id, lastSeq: 1 },
    );

    // The whole point: the client is told its own position is stale and receives
    // exactly the gap. Returning `events: []` here would be the bug.
    expect(snapshot.events.length).toBeGreaterThan(0);
    expect(snapshot.events.every((e) => e.seq > 1)).toBe(true);
    expect(snapshot.events.map((e) => e.seq)).toEqual(
      [...snapshot.events.map((e) => e.seq)].sort((a, b) => a - b),
    );
    // The snapshot's own state is current, so the client can render immediately.
    expect(snapshot.ride.status).toBe('IN_PROGRESS');
    expect(snapshot.lastSeq).toBe(snapshot.events.at(-1)?.seq ?? 1);
  });

  it('returns an empty tail for a client that is already current', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);

    const client = await connect(rider.accessToken);
    const snapshot = await ack<{ events: unknown[]; lastSeq: number }>(client.socket, 'ride:sync', {
      rideId: ride.id,
      lastSeq: 99,
    });

    // Nothing missed, so nothing replayed — and crucially, `lastSeq` does not
    // regress to 0, which would make the next sync replay the client's entire
    // history.
    expect(snapshot.events).toEqual([]);
    expect(snapshot.lastSeq).toBe(99);
  });

  it('refuses to resync a ride the client is not party to', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const stranger = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);

    const client = await connect(stranger.accessToken);

    // The refusal is observable as *no snapshot*, not as a status code: the
    // gateway throws RideNotFoundError and socket.io sends no ack for a handler
    // that threw. 404-shaped rather than 403 on purpose — a 403 would confirm the
    // ride id exists, which makes the socket an enumeration oracle.
    await expect(ack(client.socket, 'ride:sync', { rideId: ride.id, lastSeq: 0 }, 1_500)).rejects.toThrow(
      /no ack/,
    );

    // And the ride genuinely exists and has events, so the absence above is a
    // refusal and not an empty stream or a typo in the id.
    const visible = await ctx.prisma.rideEvent.count({ where: { rideId: ride.id } });
    expect(visible).toBeGreaterThan(0);
  });

  it('rejects an unauthenticated handshake', async () => {
    // Not a `connect_error`. The server authenticates in handleConnection and
    // calls `socket.disconnect(true)`, so the client observes a successful
    // handshake followed immediately by a close. Asserting on connect_error would
    // be asserting on the mechanism rather than the property, and would still pass
    // if the disconnect were removed.
    const client = await connectRideSocket(ctx.url, '');

    await new Promise((resolve) => {
      if (!client.socket.connected) return resolve(undefined);
      client.socket.once('disconnect', () => resolve(undefined));
      setTimeout(resolve, 1_000);
    });

    // The property that matters: the socket is never usable for data.
    expect(client.socket.connected).toBe(false);
    await expect(ack(client.socket, 'ride:join', { rideId: 'any', lastSeq: 0 }, 1_000)).rejects.toThrow();

    await client.disconnect();
  });

  it('delivers a committed transition to a subscribed rider', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const driver = await registerActor(ctx.http(), 'DRIVER');
    const ride = await requestRide(ctx.http(), rider);

    const client = await connect(rider.accessToken);
    await ack(client.socket, 'ride:join', { rideId: ride.id, lastSeq: 0 });

    await acceptRide(ctx.http(), ride.id, driver);

    // Matched on status, not just on the event name: `ride:status_changed` is
    // published for every transition, and the `ride.requested` publish can land
    // after the join if the 250ms relay poll loses the race. Taking the first one
    // would make this test depend on relay timing.
    const payload = await client.waitForWhere<{ rideId: string; seq: number; status: string }>(
      'ride:status_changed',
      (p) => p.status === 'ACCEPTED',
    );
    expect(payload.rideId).toBe(ride.id);
    expect(payload.seq).toBe(2);

    // The accept also carries the assigned driver, which is what actually
    // resolves the rider's "who is coming?" question.
    const assigned = (await client.waitFor('ride:assigned')) as { driverId: string };
    expect(assigned.driverId).toBe(driver.id);
  });

  it('does not deliver one rider\'s events to another rider', async () => {
    // The negative counterpart to the test above, and the one that actually
    // catches an over-broad room join. Every client connects and lands in
    // AVAILABLE_DRIVERS_ROOM or a driver room; only `ride:join` puts anyone in a
    // ride room, so this fails if a join is ever loosened.
    const rider = await registerActor(ctx.http(), 'RIDER');
    const other = await registerActor(ctx.http(), 'RIDER');
    const driver = await registerActor(ctx.http(), 'DRIVER');
    const ride = await requestRide(ctx.http(), rider);

    const bystander = await connect(other.accessToken);
    // Deliberately not joining the ride room.
    await ack(bystander.socket, 'ride:join', { rideId: ride.id, lastSeq: 0 }).catch(() => undefined);

    await acceptRide(ctx.http(), ride.id, driver);

    expect(await bystander.saw('ride:status_changed', 800)).toBe(false);
    expect(bystander.received).toHaveLength(0);
  });

  it('applies a socket-originated transition through the same use-case as HTTP', async () => {
    // §4.8's "one way a ride state can change". A socket write must not be a
    // privileged back door: the version check and the event log apply, so a
    // stale client is rejected here exactly as it would be over HTTP.
    const rider = await registerActor(ctx.http(), 'RIDER');
    const driver = await registerActor(ctx.http(), 'DRIVER');
    const ride = await requestRide(ctx.http(), rider);
    const accepted = await acceptRide(ctx.http(), ride.id, driver);

    const client = await connect(driver.accessToken);
    await ack(client.socket, 'ride:join', { rideId: ride.id, lastSeq: 0 });

    const ok = await ack<{ ok: boolean; version: number; status: string }>(
      client.socket,
      'ride:transition',
      { rideId: ride.id, to: 'IN_PROGRESS', version: accepted.version },
    );

    expect(ok.ok).toBe(true);
    expect(ok.status).toBe('IN_PROGRESS');

    // The stale-version write is the actual invariant: a second attempt at the
    // same version must fail, so a reconnecting client cannot double-apply.
    await expect(
      ack(
        client.socket,
        'ride:transition',
        { rideId: ride.id, to: 'IN_PROGRESS', version: accepted.version },
        1_500,
      ),
    ).rejects.toThrow(/no ack/);

    const events = await ctx.prisma.rideEvent.findMany({
      where: { rideId: ride.id },
      orderBy: { seq: 'asc' },
    });
    // requested, accepted, started — and no duplicate. The event type is
    // `ride.started` for an IN_PROGRESS transition: the audit vocabulary is about
    // what happened, not about the state it produced.
    expect(events.map((e) => e.eventType)).toEqual([
      'ride.requested',
      'ride.accepted',
      'ride.started',
    ]);
  });
});
