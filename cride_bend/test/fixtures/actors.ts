import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Http } from './http';

/**
 * Test actors and rides, created through the real HTTP surface.
 *
 * Deliberately not through repositories. A factory that inserts a user row
 * directly would skip password hashing, the refresh-token family and the audit
 * event, and a test built on it would pass while the registration path was broken.
 * Everything here goes through the same endpoints a browser would use.
 */

export type Role = 'RIDER' | 'DRIVER';

export interface Actor {
  id: string;
  email: string;
  password: string;
  role: Role;
  accessToken: string;
  /** Bearer header value, ready to hand to supertest. */
  auth: string;
}

export interface RideSummary {
  id: string;
  status: string;
  version: number;
  riderId: string;
  driverId: string | null;
  /** Set by the transition that caused it, and null before that. */
  acceptedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

let sequence = 0;

/** Unique per call, so parallel suites never collide on the unique email index. */
function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${randomUUID()}@test.cride`;
}

export async function registerActor(
  http: Http,
  role: Role,
  overrides: { email?: string; password?: string; displayName?: string } = {},
): Promise<Actor> {
  const email = overrides.email ?? uniqueEmail(role.toLowerCase());
  const password = overrides.password ?? 'correct-horse-battery';

  const res = await http
    .post('/auth/register')
    .send({ email, password, displayName: overrides.displayName ?? `Test ${role}`, role })
    .expect(201);

  return toActor({
    id: res.body.user.id,
    email,
    password,
    role,
    accessToken: res.body.accessToken,
  });
}

export async function loginActor(
  http: Http,
  role: Role,
  overrides: { email?: string; password?: string } = {},
): Promise<Actor> {
  const email = overrides.email ?? uniqueEmail(role.toLowerCase());
  const password = overrides.password ?? 'correct-horse-battery';

  await http.post('/auth/register').send({ email, password, displayName: 'Seed', role }).expect(201);

  const res = await http.post('/auth/login').send({ email, password }).expect(200);

  return toActor({
    id: res.body.user.id,
    email,
    password,
    role,
    accessToken: res.body.accessToken,
  });
}

function toActor(actor: Omit<Actor, 'auth'>): Actor {
  return { ...actor, auth: `Bearer ${actor.accessToken}` };
}

export async function requestRide(http: Http, rider: Actor): Promise<RideSummary> {
  const res = await http
    .post('/rides')
    .set('Authorization', rider.auth)
    .send({
      pickup: { lat: 37.7955, lng: -122.3937 },
      dropoff: { lat: 37.7749, lng: -122.4194 },
      pickupAddress: 'Ferry Building',
      dropoffAddress: '1 Market St',
    })
    .expect(201);

  return res.body as RideSummary;
}

export async function acceptRide(
  http: Http,
  rideId: string,
  driver: Actor,
): Promise<RideSummary> {
  const res = await http
    .patch(`/rides/${rideId}/accept`)
    .set('Authorization', driver.auth)
    .send({})
    .expect(200);

  return res.body as RideSummary;
}

/** request → accept → IN_PROGRESS, the state a driver is in while moving. */
export async function startRide(
  http: Http,
  rideId: string,
  driver: Actor,
  version: number,
): Promise<RideSummary> {
  const res = await http
    .patch(`/rides/${rideId}/status`)
    .set('Authorization', driver.auth)
    .send({ to: 'IN_PROGRESS', version })
    .expect(200);

  return res.body as RideSummary;
}

export async function completeRide(
  http: Http,
  rideId: string,
  driver: Actor,
  version: number,
): Promise<RideSummary> {
  const res = await http
    .patch(`/rides/${rideId}/status`)
    .set('Authorization', driver.auth)
    .send({ to: 'COMPLETED', version })
    .expect(200);

  return res.body as RideSummary;
}

/**
 * A full trip, for tests that need a ride in a terminal state to argue about.
 * Returns the final version so a follow-up assertion does not have to guess.
 */
export async function completedTrip(
  http: Http,
  rider: Actor,
  driver: Actor,
): Promise<{ ride: RideSummary; version: number }> {
  const ride = await requestRide(http, rider);
  const accepted = await acceptRide(http, ride.id, driver);
  const started = await startRide(http, ride.id, driver, accepted.version);
  const done = await completeRide(http, ride.id, driver, started.version);
  return { ride: done, version: done.version };
}

export async function closeApp(app: INestApplication): Promise<void> {
  await app.close();
}
