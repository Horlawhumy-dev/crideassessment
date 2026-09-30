# C-Ride — Submission Notes

Answers to the closing questions.

---

## 10. Which parts of the assessment did you complete?

All of it, with one explicitly flagged exception (the driver–rider matching
algorithm — see Q11).

**Backend (`cride_bend`).** NestJS 11, Prisma 6, Postgres 16, Redis 7, BullMQ,
Socket.IO. 144 TypeScript source files.

- 17 HTTP routes across 4 controllers, plus a `/rides` socket namespace.
  Everything authenticated is default-deny: `JwtAuthGuard` is registered as
  `APP_GUARD`, so a route is public only if it carries `@Public()`.
- Ride lifecycle as an explicit state machine: `REQUESTED → ACCEPTED →
  IN_PROGRESS → COMPLETED`, plus `CANCELLED`. The legal-transition *graph* lives
  in `src/rides/domain/ride-status.ts`; the actor and ownership *rules* live in
  `src/rides/domain/ride-policy.ts`. Cancellation is asymmetric by design — a
  rider may only cancel before a driver has committed, the assigned driver may
  cancel `ACCEPTED` or `IN_PROGRESS` and stays on the ride afterwards.
- 9 Prisma models, 4 migrations. Money is `BigInt` minor units end to end.
  Concurrency is enforced in the database, not in application code: a
  conditional `UPDATE ... WHERE status = 'REQUESTED'` for accept, a `version`
  column for optimistic concurrency, and a partial unique index for one active
  ride per rider.
- Transactional outbox. A ride write, its `RideEvent`, and its
  `OutboxMessage` commit in one transaction; five publishers drain the table
  (realtime, push, in-app, driver offers, route recorder) with backoff and a
  dead-letter state after 8 attempts.
- Realtime with resync: every ride event carries a per-ride monotonic `seq`, so
  a client that misses frames calls `ride:sync` and gets `{ride, events, lastSeq}`
  from `eventsAfter(lastSeq)`. `@@unique([rideId, seq])` is what makes that
  provable.
- Location: validated ingress (assigned-driver check, coordinate validity,
  per-driver rate limit, teleport rejection), buffered in Redis, fanned out
  through the same outbox-shaped egress guard that elects one emitter across
  replicas.
- 12 unit specs (139 cases) and 7 e2e specs (62 cases) against real Postgres and
  Redis. The e2e suite includes a 20-simultaneous-driver accept race, a
  token-tampering sweep over every non-public route, refresh-family burn on
  replay, and a full illegal-transition matrix.

**Frontend (`cride_fend`).** Next.js 16 App Router, React 19, Tailwind v4,
TanStack Query 5, MapLibre GL, Base UI. ~5,600 hand-written lines.

- Rider and driver dashboards, trip history with keyset pagination, in-app
  notification inbox, device management, sign-in/register.
- Live map: travelled path and remaining route drawn as two layers updated via
  `setData`; driver position follows server-confirmed frames only.
- The ride state is a hand-written pure reducer (`lib/rides/machine.ts`) whose
  `EFFECTS` table declares which fields each socket event is permitted to touch.
  A frame physically cannot invent a fare, a pickup, or a rider.
- `lib/generated/api.d.ts` is generated from the live `/docs-json`, and CI
  diffs it against a running API rather than regenerating it — regenerating and
  checking in one step would make the drift check compare the file to itself.
- 60 frontend unit tests, all passing.

**Cross-cutting.** CI in two dependency-ordered jobs (`api` → `web`) that boots
the real API against real infrastructure. A design-token linter that fails the
build on hardcoded colour literals outside a justified allowlist — it exists
because the audit that prompted it found 191 hex values against a complete and
entirely unused token set.

---

## 11. Which parts did you intentionally leave incomplete, and why?

**Driver–rider matching is not implemented.** `DRIVER_MATCHING_ENABLED`
defaults to `false` and `DriverOfferHandler` returns early. There is no
nearest-driver algorithm. The entire mechanism today is `GET /rides/available`
(a driver-pulled feed) plus offers broadcast to the `drivers:available` room.
This is deferred deliberately, not overlooked: the matching problem is the part
of a ride system most likely to be replaced by a real geospatial index
(Per-department or a separate matching service), and building it on top of
in-memory haversine would have meant building the wrong thing carefully.

**`ride-matching` has a producer and no consumer. `ride-expiry` is registered as
a queue and has neither.** Expiry is a Redis-locked scheduler instead, because
it is a scan-and-sweep, not a unit of work. Both are left as-is rather than
deleted because the ports are the seam a real matching implementation would
plug into.

**No component tests.** `@testing-library/react` is installed and imported for
jest-dom, but every frontend test is a pure-function test — zero `render()` calls.
The 60 tests that exist are on the two pieces where pure-function testing is
genuinely the right tool (the frame reducer and the formatting/error layer), but
the UI surface is unverified.

**Also incomplete, lower priority:** no metrics exporter (the counter registry in
`platform/otel/metrics.ts` records values that never leave the process); no
`Dockerfile` or deployment manifests; no React error boundaries or Suspense
boundaries; no code splitting, so `maplibre-gl` (~800 KB) ships in the initial
bundle of every authenticated page; the dark-mode token set is fully specified
but nothing ever sets the `.dark` class, so it is unreachable.

**Not started at all:** payments, driver payouts, ratings, chat, scheduled
rides, multi-stop trips, fare surge, admin surfaces, fraud/abuse detection.

---

## 12. What would you improve with another 2–3 days?

** Better UI design

** A `Dockerfile` per service

** a real metrics exporter (OTLP or a Prometheus
scrape endpoint — the instrumentation is already there, only the transport is
missing)

** a load test: a k6 script that boots N drivers against a live
socket namespace and asserts accept-race behaviour under contention.
---

## 13. How would I scale this to 10,000 concurrent rides?

First, the distinction the number hides: 10,000 concurrent *rides* is a very
different load from 10,000 concurrent *connections*. One ride generates one
socket, and most connections are idle most of the time. The binding constraint is
location frames, not rides: at the current 3-second floor that is ~3,300
location messages/second, and 10,000 rides in motion is ~3,300 msg/s egress too.
The architecture is mostly built for that; the places it is not are listed below
in the order I would fix them.

**Already correct at this scale, and worth naming because it is why the rest is
feasible:**

- **Stateless API instances.** No in-process session or ride state; the
  composition root binds every port to an adapter and nothing holds state between
  requests. Horizontal scaling is a load-balancer config change.
- **The Redis event bus, not direct gateway calls.** The outbox relay runs in the
  worker process while sockets live on API instances. The relay publishes to
  `bus:ride-events`; every API instance subscribes and emits to its own local
  sockets. Delivery is therefore independent of process topology — this is the
  single decision that makes multi-instance real-time work at all.
- **`EgressGuard.claimOnce`.** Every instance receives every bus event, so
  exactly one emitter is elected per `(eventId, event, audience, audienceId)`.
  The key includes event name and audience because one committed event
  legitimately publishes several distinct messages — `ride.accepted` produces
  both `ride:status_changed` and `ride:assigned`, which are different things,
  not duplicates.
- **Keyset pagination everywhere** (`encodeCursor`/`decodeCursor` over
  `{createdAt, id}`). Offset pagination skips or repeats rows when a ride
  notification arrives mid-scroll, so it is not a thing to scale into.
- **Authorization before cache.** Documented on `RideCachePort` itself: a cached
  read is only reached after the ownership check passes, so the cache never
  becomes an enumeration oracle.
- **Idempotency at both tiers.** `IdempotencyKey` stores the response body, so a
  retried `POST /rides` returns the stored response rather than creating a
  second ride. Notifications dedupe on a Redis `SETNX` fast path plus a durable
  `NotificationDelivery` row, because a Redis flush would otherwise resurrect
  delivered messages.

**What I would actually change, in order:**

1. **Driver matching becomes a real service.** This is the scaling blocker, and
   it is the part I did not build. Polling `GET /rides/available` does not work
   at 10,000 — a driver in a busy zone refreshes a list that every other driver
   is also refreshing, and the fan-out is O(drivers × requests). Replace with a
   geospatial index: Redis `GEOSEARCH` on a `GEOADD`-maintained set of available
   drivers, or Per-department/PostGIS `ST_DWithin`. The `ride-matching` queue and
   its `DRIVER_MATCHING_ENABLED` flag are the seam this plugs into. At that
   point driver location updates need to be written to a geo set, not just a
   per-ride TTL key — which also means the location write path goes from
   "Redis list" to "geo index plus list", and the list becomes the audit trail
   rather than the query surface.

2. **WebSocket fan-out topology.** The Redis adapter handles cross-instance
   delivery, but every instance still receives every bus event. Past roughly a
   few thousand sockets, shard the bus by region hash and run one relay
   subscription per shard so a ride's events only reach the instances that can
   actually have a socket in that ride's room. This is a change to the channel
   naming, not to the outbox.

3. **Location is the real write load.** 3,300 msg/s through Node is feasible but
   not free, and the current path does a Redis claim per frame for rate limiting.
   The two things that pay for themselves: sample at the edge (the 4 m jitter
   filter already exists client-side in `extendPath`; moving the equivalent
   server-side removes most frames before they touch Redis), and batch the
   egress rather than emitting per frame. A 3-second floor is already generous;
   raising it to 5 and batching into ~1-second windows cuts egress substantially
   for no visible difference at city scale.

4. **Postgres before it hurts.** `acceptIfRequested` and `transitionWithVersion`
   are single-statement conditional updates, which is the right shape and is
   already index-supported. What needs attention at volume is `route_points` —
   an append-heavy table with a `@@unique([rideId, seq])` index. Partition it by
   `rideId` hash or by time, and roll completed rides' points into cold storage.
   Reads of the active set are already narrow because the partial unique index
   caps a rider at one active ride.

5. **Move expiry off a poll.** The sweep runs under a Redis lock every 60s and
   re-reads each ride inside the transaction, which is correct but is a
   full-table-ish scan repeated forever. At 10,000 rides, drive it off
   `availableAt` on a zset ordered by offer expiry, so each sweep touches only
   the rows that are actually due.

6. **Things I would leave alone.** The outbox relay's `FOR UPDATE SKIP LOCKED`
   batch claim already scales horizontally without coordination. The transaction
   boundary is the right one. The partial unique index is a database guarantee
   and stays a database guarantee — moving that to application logic at 10,000
   rides is how you get double-bookings.

**What I would measure before building any of it,** because the estimates above
are reasoning and not data: socket count and location frame rate per instance,
outbox relay lag (the `PENDING` queue depth is the honest SLO — it is how long
after commit a rider's push has not gone out), accept-race p99 under contention,
and Postgres connection pool saturation. A k6 script that boots N drivers and
measures these is the first thing I would write, and it comes before all six
items above.

---

## 14. Security considerations before production

**Already in place, and I would want these to survive any refactor:**

- **Both cookies are `httpOnly` and `sameSite: 'lax'`.** Lax rather than strict is
  deliberate — strict logs users out on external-link navigation — and the API is
  on its own origin, so the cookie is not readable cross-origin at all.
- **Throttling runs before auth.** `ThrottlerGuard` is ordered ahead of
  `JwtAuthGuard` in `app.module.ts:68-80`, so a credential flood costs a counter
  increment, not a bcrypt call. Login and register are capped at 5/min.
- **Non-enumeration.** An unknown address still runs a dummy bcrypt comparison,
  so the unknown-address and wrong-password paths cost comparable time and return
  the same code. Registration returns the same code for a duplicate email. A ride
  that is not yours and a ride that does not exist are both `RIDE_NOT_FOUND`, on
  HTTP and on the socket.
- **Least privilege in the ride room.** `canSubscribeToRide` decides socket room
  joins, and a driver never assigned to a ride cannot observe it — otherwise
  offers become a way to probe a rider's trip history.
- **Ingress validation on location** before anything touches Postgres:
  assigned-driver check, status check, coordinate validity, per-driver rate
  limit, and teleport rejection against the last known point.
- **Config that fails closed.** A single Zod schema runs at boot. `production`
  refuses a `dev-only` JWT secret and a `CORS_ORIGIN` of `*`. The `bool()` helper
  is not `z.coerce.boolean()` because coercion inverts `FCM_ENABLED=false` — it
  accepts only an explicit set of literals and rejects anything else.

**Would block deployment:**

2. **Secret storage.** Secrets are environment variables with checked-in example
   values. Production needs a real secret manager, rotation, and separate values
   per environment. The `dev-only` guard catches the *default* being used, not a
   leaked real one.
3. **Denial-of-wallet on location and ride endpoints.** The throttle is a global
   120/min plus 5/min on auth. A driver streaming location and a rider polling
   are both throttled by the same bucket as a script hammering `POST /rides`. I
   want per-role, per-route limits, and an edge/WAF layer in front of the API.
4. **Rate limiting on the socket namespace.** The Redis claims that protect
   location ingress are per-driver and correct, but `ride:join`, `ride:sync`, and
   `ride:transition` have no per-socket rate limit. A single authenticated socket
   can call `ride:sync` in a loop.
5. **A real authorization review of the driver feed.** `GET /rides/available`
   returns active requests. Today it requires a driver role, and the room
   membership is gated on the *persisted* availability flag re-read from the
   database rather than the payload — but "any driver can list all open requests"
   is a business-logic question I answered by assumption, not by requirement.

**Would want before real users:**

6. **No TLS termination and no `secure` cookies in dev.** `secure` is bound to
   `NODE_ENV === 'production'`, so this is config, not code — but it means
   production must terminate TLS and must not run with `NODE_ENV` unset.
7. **No CSP, HSTS, or `Referrer-Policy` headers.** Nothing sets them.
8. **No audit log of privileged actions.** Ride state changes are recorded as
   `RideEvent`, which is good, but there is no security-side log of auth events
   (failed logins, token family burns, device revocations) distinct from
   application logs.
9. **PII in logs.** The logging interceptor uses a URL allowlist rather than
   logging every path, which helps, but I would want an explicit pass over what
   `correlation-id` propagation and error bodies can carry. Emails appear in
   request bodies; the correlation id is validated against
   `/^[A-Za-z0-9._:-]+$/` and capped at 128 chars specifically so an echoed
   header cannot inject into logs, which is the right instinct applied in only
   one place.
10. **Data retention and account deletion.** The brief does not say. Ride history,
    route points, and device tokens are all retained indefinitely and there is no
    deletion path — including for a user who asks.
11. **No MFA and no brute-force lockout** beyond the 5/min throttle, which is
    per-process without a shared store. Behind multiple instances the effective
    limit multiplies by the instance count.

---

## 15. Assumptions I made

Where an assumption is load-bearing, I tried to make the code enforce it rather
than trust it. The list below is the ones that remain genuinely assumed.

**Domain**
- One city. Osogbo, Nigeria; fixed default map view, NGN default fare table, no
  time zones to speak of. Multi-city would need a currency and region on the
  fare policy.
- Haversine on plain `Decimal` coordinates rather than PostGIS geography, and a
  fixed 30 kph average speed for duration. Documented as "accurate enough at
  city scale" — it is not accurate enough for a fare anyone disputes, which is
  why `ARRIVED` was removed and the estimate is presented as an estimate.
- A ride is `REQUESTED → ACCEPTED → IN_PROGRESS → COMPLETED` with no `ARRIVED`
  intermediate. I removed it because the frontend had no way to demonstrate a
  meaningful arrival handshake and a status nobody can act on is a status that
  lies. This is a real product decision and a reviewer may reasonably disagree.
- Cancellation is asymmetric: rider before commit, assigned driver after. The
  driver is retained on a cancelled ride. Both are enforced in
  `ride-policy.ts`, not in controllers.
- One active ride per rider, enforced by a partial unique index. A partial index
  is not expressible in Prisma, so it lives in migration `0002`.
- "System" is a first-class actor for attribution, so expiry is not
  indistinguishable from a user action in the event stream.

**Scope**
- Push is best-effort; the in-app inbox is the source of truth. A notification
  that FCM rejected because the device is dead is dropped, not retried forever —
  retrying a permanent failure is how a queue wedges with thousands of
  unsatisfiable jobs.
- The HTTP API and the socket are two transports over the *same* use cases.
  `ride:transition` calls `TransitionRideUseCase`, not the gateway, so there is
  exactly one way a ride state can change. The frontend currently drives
  transitions over REST only; the socket path is built and exercised by e2e but
  unused by the UI, which contradicts the "lower latency path" comment in
  `lib/realtime/socket.ts`.
- Authorisation is a backend concern. The frontend mirrors the policy in
  `lib/ride-status.ts` only so a rider never sees a button that would fail, and
  additionally filters out any action with no handler.

**Infrastructure**
- Postgres is a hard dependency; Redis failure reports *degraded*, not *down*,
  because the system can still serve reads.
- The socket connects browser-to-API directly with an httpOnly cookie, not
  through the Next.js proxy. A client-side socket cannot read an httpOnly cookie
  and the handshake is cross-origin. This is load-bearing and non-obvious.
- `transports` is deliberately left at the Socket.IO default. Pinning
  `['websocket','polling']` empirically produced a silently broken connection —
  the UI read "live", no handler ever ran, no ack ever came. Omitting the option
  was the only correct config.
- The outbox is the only reason a committed ride cannot fail to notify anyone.
  Nothing after `COMMIT` is allowed to fail the request, which is why
  `QueueProducer.send` re-throws instead of swallowing — a swallowed error reads
  as success to the relay, rows get marked `PUBLISHED`, and the retry ladder,
  dead-letter state, and `lastError` column all become unreachable.
