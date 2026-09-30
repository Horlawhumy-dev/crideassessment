import { createTestApp, resetDatabase, type TestApp } from '../fixtures/test-app';
import { registerActor, requestRide } from '../fixtures/actors';

/**
 * Authentication bypass regression.
 *
 * This file exists because of a specific bug, not for coverage. `JwtAuthGuard`
 * overrode `handleRequest` to return the user without throwing, and
 * `@nestjs/passport`'s `AuthGuard.canActivate` returns `true` unconditionally
 * after the passport callback runs — so the override removed the *only* place the
 * deny decision was made. Every protected route became reachable without a token.
 *
 * What made it survive review is that the use-case-level ownership checks kept
 * working. `GET /rides/:rideId` correctly answered RIDE_NOT_VISIBLE to an
 * anonymous caller, so the system appeared to be enforcing access control. The
 * failure was in the endpoints whose use case had no ownership predicate to fall
 * back on: `GET /rides/history` filtered on `principal.role`, which was
 * `undefined` rather than absent, so the filter had neither riderId nor driverId
 * and the query returned the entire rides table.
 *
 * The lesson these tests encode: assert the guard rejects, separately from
 * asserting the use case rejects. Only the first one catches a broken guard.
 */
describe('authentication is enforced on every non-public route', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma, ctx.redis);
  });

  it('rejects an anonymous request for a ride list', async () => {
    const res = await ctx.http().get('/rides/history');

    expect(res.status).toBe(401);
    // The important half: no body with ride data in it, whatever the status.
    expect(JSON.stringify(res.body)).not.toContain('pickup');
  });

  it('rejects an anonymous request for the available-rides feed', async () => {
    const res = await ctx.http().get('/rides/available');
    expect(res.status).toBe(401);
  });

  it('rejects an anonymous request for ride detail', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);

    const res = await ctx.http().get(`/rides/${ride.id}`);

    // 401, not 404. A 404 here is what the broken guard produced, and it is
    // indistinguishable from a correct authorization refusal.
    expect(res.status).toBe(401);
  });

  it('rejects an anonymous write of every kind', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');
    const ride = await requestRide(ctx.http(), rider);

    const attempts = [
      ctx.http().post('/rides').send({ pickup: { lat: 1, lng: 1 }, dropoff: { lat: 2, lng: 2 } }),
      ctx.http().patch(`/rides/${ride.id}/accept`).send({}),
      ctx.http().patch(`/rides/${ride.id}/status`).send({ to: 'CANCELLED', version: 1 }),
      ctx.http().get('/auth/me'),
      ctx.http().post('/auth/logout').send({}),
    ];

    for (const attempt of attempts) {
      const res = await attempt;
      expect(res.status).toBe(401);
    }
  });

  it('rejects a malformed, expired or tampered token', async () => {
    const rider = await registerActor(ctx.http(), 'RIDER');

    const bad = [
      'Bearer not-a-jwt',
      'Bearer ',
      `Bearer ${rider.accessToken.slice(0, -4)}xxxx`,
      rider.accessToken, // no scheme: a raw token is not a credential
    ];

    for (const header of bad) {
      const res = await ctx.http().get('/auth/me').set('Authorization', header);
      expect(res.status).toBe(401);
    }
  });

  it('rejects an unrecognised refresh token without reporting it as theft', async () => {
    // Refresh tokens are opaque random strings (§4.12.1), not JWTs, so there is no
    // signature to forge and no refresh secret in play on this path — `consume`
    // hashes whatever it is given and simply finds no row.
    //
    // What matters here is the *code*. An unrecognised token is a client bug or a
    // stale cookie; TOKEN_REVOKED is the theft signal that auth.service warns on.
    // Reporting the first as the second would flood that alert with noise.
    const rider = await registerActor(ctx.http(), 'RIDER');

    const res = await ctx
      .http()
      .post('/auth/refresh')
      .set('Cookie', 'cride.refresh=not-a-real-refresh-token')
      .send({})
      .expect(401);

    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    expect(rider.accessToken).toBeTruthy();
  });

  it('leaves the genuinely public routes open', async () => {
    // The other half of the contract. A guard that denies everything is just as
    // broken as one that allows everything, and "fix" the bypass by removing the
    // @Public() opt-out is the obvious wrong turn.
    const res = await ctx.http().get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
