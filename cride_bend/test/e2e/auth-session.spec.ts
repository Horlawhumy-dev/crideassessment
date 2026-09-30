import { createTestApp, resetDatabase, type TestApp } from '../fixtures/test-app';
import { registerActor, type Actor } from '../fixtures/actors';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../src/common/openapi/cookie-names';
import type request from 'supertest';

/**
 * Session lifecycle: cookies, rotation, and the replay signal.
 *
 * The property under test throughout is §4.4's: rotation is what makes a stolen
 * refresh token *detectable*. A refresh token that can be replayed silently is
 * indistinguishable from a legitimate one, so the whole rotation design — a token
 * family per session, single-use tokens, family revocation — exists to turn "an
 * attacker used my token" into "both of us got logged out". A test that only checks
 * "refresh returns a new token" would pass against an implementation with none of
 * that, which is why the reuse cases below are the interesting ones.
 */
describe('auth session lifecycle', () => {
  let ctx: TestApp;
  const PASSWORD = 'correct-horse-battery';

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma, ctx.redis);
  });

  /** Extracts a Set-Cookie value by name, without pulling in a cookie parser. */
  function cookieFrom(res: request.Response, name: string): string | undefined {
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list
      .map((c) => c.split(';')[0] ?? '')
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  }

  it('sets httpOnly cookies and returns the principal', async () => {
    const res = await ctx
      .http()
      .post('/auth/register')
      .send({ email: 'a@test.cride', password: PASSWORD, displayName: 'A', role: 'RIDER' })
      .expect(201);

    const access = cookieFrom(res, ACCESS_COOKIE);
    const refresh = cookieFrom(res, REFRESH_COOKIE);

    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();

    // The property the whole §4.8.4 decision rests on. A cookie readable from
    // JavaScript is worse than no cookie: it is still exfiltratable by an XSS
    // payload, so httpOnly is the part that must not be negotiable.
    const setCookies = [res.headers['set-cookie']].flat() as string[];
    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
      const header = setCookies.find((c) => c.startsWith(`${name}=`));
      expect(header).toMatch(/HttpOnly/i);
      // SameSite=Lax, not Strict. Lax still blocks the token on a cross-site POST
      // — the CSRF-relevant case, since every state-changing route here is a POST
      // or PATCH — while Strict would also suppress the cookie on a top-level GET
      // navigation, breaking the OAuth return trip. Asserted loosely on purpose:
      // the security property is "SameSite is set", not one particular value.
      expect(header).toMatch(/SameSite=(Strict|Lax)/i);
      expect(header).toMatch(/Path=\//i);
    }
  });

  it('authenticates a request by cookie alone, with no Authorization header', async () => {
    // The browser case. A client that only ever sets cookies must work, because
    // the driver app is a PWA and there is no localStorage token to send.
    const register = await ctx
      .http()
      .post('/auth/register')
      .send({ email: 'b@test.cride', password: PASSWORD, displayName: 'B', role: 'RIDER' })
      .expect(201);

    const access = cookieFrom(register, ACCESS_COOKIE);

    const me = await ctx
      .http()
      .get('/auth/me')
      .set('Cookie', `${ACCESS_COOKIE}=${access}`)
      .expect(200);

    // `/auth/me` returns the Principal plus the account behind it. The three
    // identity fields come from the token; the profile is loaded per request.
    expect(me.body.userId).toBe(register.body.user.id);
    expect(me.body.role).toBe('RIDER');
    expect(me.body.sessionId).toEqual(expect.any(String));

    // The account is nested under `user`, never spliced into the top level: the
    // top level is the token's claim set, and a UI must not be able to read a
    // field it should be treating as server-asserted identity.
    expect(me.body.user).toMatchObject({
      id: register.body.user.id,
      email: register.body.user.email,
      displayName: register.body.user.displayName,
      role: 'RIDER',
      isAvailable: false,
    });

    // The reason the profile is not in the JWT: base64 is not encryption, so a
    // display name inside the token is readable by anyone holding it. The token
    // therefore still carries no PII — only the separately-loaded view does.
    expect(me.body).not.toHaveProperty('passwordHash');
    expect(me.body.user).not.toHaveProperty('passwordHash');

    // A rider is never a driver, so the availability flag on a rider is a
    // vestigial false rather than something to render.
    expect(me.body.user.isAvailable).toBe(false);
  });

  it('refreshes from the cookie with an empty body', async () => {
    // The path that was broken: `refreshSchema` required `refreshToken`, so the
    // body pipe rejected a browser's empty body with 400 before the controller
    // could read the cookie. The cookie is the primary credential and the body is
    // only a fallback, so the body must genuinely be optional.
    const register = await ctx
      .http()
      .post('/auth/register')
      .send({ email: 'c@test.cride', password: PASSWORD, displayName: 'C', role: 'RIDER' })
      .expect(201);

    const refresh = cookieFrom(register, REFRESH_COOKIE);

    const res = await ctx
      .http()
      .post('/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${refresh}`)
      .send({})
      .expect(200);

    expect(res.body.accessToken).toBeTruthy();
    // Rotation: a new refresh token, different from the one presented.
    const rotated = cookieFrom(res, REFRESH_COOKIE);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(refresh);
  });

  it('reports MISSING_FIELD when neither cookie nor body carries a token', async () => {
    const res = await ctx.http().post('/auth/refresh').send({});

    // Same code the schema would have produced, so the published contract holds.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_FIELD');
  });

  it('burns the whole family when a consumed token is replayed', async () => {
    // The core of §4.4. An attacker and the legitimate client racing each other
    // both present the same token; the second use is the signal, and the response
    // is to revoke everything rather than pick a winner.
    const register = await ctx
      .http()
      .post('/auth/register')
      .send({ email: 'd@test.cride', password: PASSWORD, displayName: 'D', role: 'RIDER' })
      .expect(201);

    const original = cookieFrom(register, REFRESH_COOKIE);

    // Legitimate rotation.
    const rotated = await ctx
      .http()
      .post('/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${original}`)
      .send({})
      .expect(200);

    const current = cookieFrom(rotated, REFRESH_COOKIE);

    // The stolen copy is replayed.
    const replay = await ctx
      .http()
      .post('/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${original}`)
      .send({})
      .expect(401);
    // TOKEN_REVOKED, not INVALID_REFRESH_TOKEN: the replayed token was valid and
    // has already been consumed, which is a different diagnosis from a forged
    // one. Separating them is what makes the alert readable in a log.
    expect(replay.body.error.code).toBe('TOKEN_REVOKED');

    // And the consequence: the legitimate holder is logged out too, by design. If
    // the *current* token still worked here, the replay would have been invisible
    // and rotation would be security theatre.
    await ctx
      .http()
      .post('/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${current}`)
      .send({})
      .expect(401);
  });

  it('revokes the family on logout', async () => {
    const register = await ctx
      .http()
      .post('/auth/register')
      .send({ email: 'e@test.cride', password: PASSWORD, displayName: 'E', role: 'RIDER' })
      .expect(201);

    const access = cookieFrom(register, ACCESS_COOKIE);
    const refresh = cookieFrom(register, REFRESH_COOKIE);

    await ctx
      .http()
      .post('/auth/logout')
      .set('Authorization', `Bearer ${access}`)
      .send({})
      .expect(204);

    await ctx
      .http()
      .post('/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${refresh}`)
      .send({})
      .expect(401);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    await registerActor(ctx.http(), 'RIDER', { email: 'f@test.cride', password: PASSWORD });

    const wrongPassword = await ctx
      .http()
      .post('/auth/login')
      .send({ email: 'f@test.cride', password: 'not-the-password' })
      .expect(401);

    const noSuchUser = await ctx
      .http()
      .post('/auth/login')
      .send({ email: 'nobody@test.cride', password: PASSWORD })
      .expect(401);

    // Identical responses. A different message or code for the two cases turns
    // the login form into an account-existence oracle, which is why the codes are
    // the same INVALID_CREDENTIALS rather than one being "user not found".
    expect(wrongPassword.body.error.code).toBe(noSuchUser.body.error.code);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses a duplicate email without revealing that it is taken', async () => {
    // 401 INVALID_CREDENTIALS, not 409 EMAIL_ALREADY_REGISTERED. That is a
    // deliberate choice (auth.service.ts:60): a distinct "email already taken"
    // turns registration into a free oracle for testing whether an address has an
    // account, which is the same disclosure login goes to real trouble to avoid
    // with its dummy bcrypt compare. The cost is a confusing UX on signup; the
    // benefit is not handing out a customer list. Asserted here so the day
    // someone "fixes" this back to a 409, the change is a conscious one.
    const body = { email: 'g@test.cride', password: PASSWORD, displayName: 'G', role: 'RIDER' };
    await ctx.http().post('/auth/register').send(body).expect(201);

    const res = await ctx.http().post('/auth/register').send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('validates the request body before touching the database', async () => {
    // §4.15: a malformed body is a 400 with field-level detail and a stable code,
    // never a Prisma error surfaced to the client.
    const cases: [Record<string, unknown>, string][] = [
      [{ email: 'not-an-email', password: PASSWORD, displayName: 'H', role: 'RIDER' }, 'email'],
      [{ email: 'h@test.cride', password: 'short', displayName: 'H', role: 'RIDER' }, 'password'],
      [{ email: 'h@test.cride', password: PASSWORD, displayName: '', role: 'RIDER' }, 'displayName'],
      [{ email: 'h@test.cride', password: PASSWORD, displayName: 'H', role: 'ADMIN' }, 'role'],
    ];

    for (const [body, field] of cases) {
      const res = await ctx.http().post('/auth/register').send(body);
      expect(res.status).toBe(400);
      // MISSING_FIELD is the ZodValidationPipe's code for any schema failure, not
      // just an absent field. The field-level detail is what makes it useful.
      expect(res.body.error.code).toBe('MISSING_FIELD');
      expect(JSON.stringify(res.body.error.details)).toContain(field);
    }
  });

  it('issues an access token scoped to the registered role', async () => {
    // A rider token must not be usable where a driver token is required, and the
    // role lives in the signed claim rather than in a client-supplied header.
    const rider: Actor = await registerActor(ctx.http(), 'RIDER', { email: 'i@test.cride' });

    const me = await ctx.http().get('/auth/me').set('Authorization', rider.auth).expect(200);
    expect(me.body.role).toBe('RIDER');
    expect(me.body.userId).toBe(rider.id);

    // A DRIVER-only route refuses a rider.
    const res = await ctx.http().get('/rides/available').set('Authorization', rider.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
  });
});
