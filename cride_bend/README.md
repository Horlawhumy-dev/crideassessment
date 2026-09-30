# CRide API

NestJS backend for CRide: HTTP + Socket.IO gateway, Prisma/Postgres, Redis for cache,
event bus and BullMQ queues.

Runs on `http://localhost:4000`. Swagger UI at **`/docs`**, machine-readable spec at
**`/docs-json`**.

## Quick start

From the repo root (recommended — it sequences the parts that are easy to get wrong):

```bash
make setup   # deps, containers, migrations, seed, e2e test database
make dev-api # this service, with reload
```

On its own:

```bash
cp .env.example .env          # the only step that needs a decision; see below
docker compose up -d --wait   # Postgres + Redis
npm install                   # postinstall runs prisma generate
npm run db:deploy             # apply migrations
npm run db:seed               # demo rider + 3 drivers
npm run start:dev             # http://localhost:4000
```

Seeded accounts (password `cride-demo-2026`):

| Role | Email |
|---|---|
| Rider | `rider@cride.ng` |
| Driver | `driver1@cride.ng`, `driver2@cride.ng`, `driver3@cride.ng` |

## Configuration

Everything is validated at boot by `src/config/env.schema.ts`, so a typo fails
immediately with the offending key named rather than surfacing later as a null
somewhere in a request.

Required, and what they are for:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres. Source of truth. |
| `REDIS_URL` | Cache, event bus, BullMQ. Not a source of truth. |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Min 16 chars. The `dev-only-*` defaults are **rejected** when `NODE_ENV=production`. |
| `CORS_ORIGIN` | Comma-separated. `"*"` is rejected in production because the session cookie needs credentials. |
| `BCRYPT_ROUNDS` | Min 10. Lowering it speeds up tests; the floor exists so nobody ships a weak hash. |
| `APP_ROLE` | `api` (HTTP + websocket), `worker` (outbox relay + queue consumers), or `all`. Read once at import time. |

Optional: `FCM_ENABLED` plus its three credentials (all-or-none), `OTEL_ENABLED`,
`DRIVER_MATCHING_ENABLED` (off by default — the seam exists, the feature is deferred),
location throttling (`LOCATION_MIN_INTERVAL_MS`, `LOCATION_MAX_JUMP_METRES`), and rate
limit tuning.

`POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` are read by `docker-compose.yml` only. They must
match the ports inside `DATABASE_URL` and `REDIS_URL`, which is what keeps a stack with
another Postgres/Redis already running from colliding.

## Roles and where they run

`APP_ROLE=all` is the convenient default for local development. In a deployment you run
`api` and `worker` as separate processes from the same image — the worker is what drains
the outbox and publishes to the bus, which is why a gateway-only process can serve
requests but never emits an event.

The outbox is the reason this is safe to split: state is committed to Postgres and an
event row in one transaction, then relayed. A crash between commit and relay loses no
state and no event.

## Architecture

```
src/
  rides/        the domain: state machine, policy, use cases, repository, controller
  auth/         registration, login, session cookies, refresh-token families
  users/        profiles and availability
  driver/       availability + driver-facing queries
  tracking/     location frames, rate limiting, jump rejection
  notifications/ FCM and in-app notifications, delivery attempts
  outbox/       transactional outbox + relay
  kernel/       cross-cutting: errors, correlation ids, egress guard
  common/       shared contracts, OpenAPI helpers
```

Each domain module keeps `domain/` (pure), `application/` (use cases) and
`infrastructure/` (Prisma, Redis) separate. The rules that matter — which transitions
exist, and who may make them — are pure functions over `(ride, principal)` with no HTTP
or database involved, which is why the authorization matrix can be asserted directly in
`ride-policy.spec.ts`.

### Ride lifecycle

```
REQUESTED ──accept──> ACCEPTED ──start──> IN_PROGRESS ──complete──> COMPLETED
     │                    │                    │
     └────cancel──────────┴────cancel──────────┴──> CANCELLED
```

Transitions go through the state machine in `src/rides/domain/ride-status.ts`; there is
no second path. `PATCH /rides/:rideId/status` and the `ride:transition` socket message
call the same use case, so a ride state cannot change two different ways.

**Always send `version`.** It makes the write conditional on the state you saw
(`RIDE_VERSION_CONFLICT` on mismatch). Omitting it is allowed but opts into
last-writer-wins.

**Cancellation is deliberately asymmetric.** A rider may cancel only while `REQUESTED` —
once a driver is committed they are no longer the only party with a claim on the trip.
The assigned driver *may* cancel at `ACCEPTED` or `IN_PROGRESS`, because they are the
only party who knows the trip is impossible. A driver who is not assigned gets
`RIDE_NOT_VISIBLE` (404), not 403, because offers are broadcast to every available
driver and a 403 would confirm the ride exists. Cancelling keeps `driverId` and records
`cancelledBy`.

### Realtime

Socket.IO with cookie auth (`cride.sid`). Clients subscribe per ride; committed events
are relayed to the bus and fanned out. Frames carry a per-ride `seq`, so a client that
sees a gap can resync rather than assume nothing was dropped.

Location frames are rate-limited per driver per ride in Redis and rejected if they
imply a teleport (`LOCATION_MAX_JUMP_METRES`).

## Database

Prisma with Postgres. Four migrations, in order:

1. `0001_init` — users, rides, events, outbox
2. `0002_integrity_constraints` — CHECK constraints and the one-active-ride-per-rider index
3. `0003_in_app_notifications`
4. `0004_cancel_keeps_driver` — permits a cancelled ride to keep its `driverId`

Some rules are enforced by the database as well as the application, because the
application is not the only writer: a driver cancelling must leave a row that says a
driver was assigned and then ended the trip, and that row would violate the old
constraint.

```bash
npm run db:migrate   # create a migration from schema changes
npm run db:deploy    # apply existing migrations (fresh clones)
npm run db:seed      # demo data
npm run db:studio    # browse
npx prisma migrate reset --force   # drop, recreate, migrate, seed — destructive
```

There is deliberately no `db:reset` script: a command that deletes a database should
require the full `prisma migrate reset --force` to be typed, not one word in a script
name that looks like the others.

### The e2e test database

The e2e suite runs against **`cride_test`**, not `cride`. It is configured in
`test/fixtures/env-e2e.ts` and is deliberately separate: the suites truncate between
cases, and pointing them at the development database would destroy seeded demo data.

`prisma migrate deploy` will not create a database, and the harness only rewrites
`DATABASE_URL` — so the database has to be created and migrated explicitly, via
`make test-db` from the repo root. Skipping that produces
`relation "in_app_notifications" does not exist` across every e2e suite at once, which
reads like a broken schema and is really just an unmigrated test database.

## Tests

```bash
npm test           # unit
npm run test:e2e   # e2e, serial
npm run verify     # prisma validate + typecheck + unit + e2e
```

The e2e suites truncate a shared database, so **two e2e runs at the same time will fail
each other** with foreign-key violations. The symptom looks like a schema bug and is not
one.

## OpenAPI

`/docs-json` is the contract the frontend generates its types from
(`npm run gen:api` in `cride_fend`). A stale server keeps serving an old spec — a
`node dist/main` from an earlier build will do it indefinitely — so restart the API
before regenerating and read the diff.
