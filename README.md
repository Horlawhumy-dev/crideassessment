# CRide Assessment

This repo contains the CRide backend (`cride_bend`) and web frontend (`cride_fend`).

## Quick start (recommended)

Use the Makefile at the repo root:

```bash
# Install deps, start infra, apply migrations, seed data, prepare test DB
make setup

# Run API (http://localhost:4000) and web (http://localhost:3000) together
make dev
```

Sign in with seeded accounts: `make seed-info`.

## Targets

Run `make help` to see all targets. Common ones:
- `make up/down/logs/infra-status` — Postgres/Redis
- `make db-migrate/db-deploy/db-seed/db-reset/db-studio` — database ops
- `make test-db` — prepare `cride_test` for e2e
- `make dev-api/dev-web/dev` — dev servers
- `make verify/verify-api/verify-web/test/e2e` — checks
- `make gen-api/check-api` — sync frontend types with running API

## Per-project docs

- Backend: [`cride_bend/README.md`](cride_bend/README.md)
- Frontend: [`cride_fend/README.md`](cride_fend/README.md)

## Architecture

Two processes, two transports, one durable write path.

```
┌─ Browser ────────────────────────────────────────────────────────────────┐
│                                                                          │
│  Rider page (/rider)          Driver page (/driver)                      │
│  lib/rides/machine.ts         lib/rides/machine.ts                       │
│    pure reducer + EFFECTS        pure reducer + EFFECTS                  │
│                                                                          │
│  ┌────────────────┐            ┌────────────────┐                        │
│  │ TanStack Query │            │ TanStack Query │                        │
│  └───────┬────────┘            └───────┬────────┘                        │
└──────────┼─────────────────────────────┼─────────────────────────────────┘
           │ HTTP                        │ HTTP
           │ (same-origin)               │ (same-origin)
           ▼                             ▼
┌─ Next.js :3000 ──────────────────────────────────────────────────────────┐
│                                                                          │
│  app/api/[...path]/route.ts   ← BFF / proxy, the ONLY http path          │
│    · forwards `cookie` header in, Set-Cookie out (getSetCookie)          │
│    · allowlist: GET POST PATCH DELETE                                    │
│    · CSRF: Sec-Fetch-Site + Origin on unsafe verbs → 403                 │
│    · no-store on everything                                              │
│                                                                          │
│  React Server Components + MapLibre GL                                   │
└──────────┬──────────────────────────────────┬────────────────────────────┘
           │ server-side fetch (API_URL)     │ Socket.IO  ← NOT proxied
           │                                  │ (browser → :4000 direct)
           ▼                                  ▼
  (cross-origin; authenticated by the httpOnly cride.sid cookie,
   credentials:'include')
┌─ NestJS :4000 ───────────────────┐
│                                  │
│ 21 HTTP routes / 6 controllers   │
│ auth rides driver devices        │
│ notifications health             │
│ ─────────────────────────────────│
│ ThrottlerGuard  ← runs FIRST     │
│ JwtAuthGuard     default-deny    │
│ RolesGuard                       │
│ RideAccessGuard  advisory        │
│ ─────────────────────────────────│
│ ride-policy.ts  ← real check     │
│ ride-status.ts  ← the graph      │
│                                  │
│ rides.gateway / location.gateway │
│ socket-auth.gateway (same JWT)   │
└──────────┬──────────────┬────────┘
           │              │
           │ one txn      │ publishes to
           ▼              ▼
┌─────────────┐   ┌──────────────────────────────────────────┐
│  Postgres   │   │  Redis                                    
│  ─────────  │   │   ├ bus:ride-events   pub/sub (fan-out)  │
│  rides      │   │   ├ ride-notifications (BullMQ)           
│  ride_events│   │   ├ location buffers + TTL keys          │
│  outbox_    │   │   └ expiry lock + zset                   │
│   messages  │   └──────────────────────────────────────────┘
│  users,     │
│  devices,   │
│  in_app_    │
│  notifs     │
└─────────────┘
```

### The write path (why the outbox exists)

```
POST /rides
   │
   └─▶ BEGIN
         ride              (conditional UPDATE … WHERE status='REQUESTED')
         ride_event        (per-ride monotonic seq, @@unique([rideId, seq]))
         outbox_message
       COMMIT          ← the only point of no return
   │
   ▼  OutboxRelay: 250ms poll, BATCH 50, claim+flip in ONE txn
      5 publishers, Promise.allSettled — one failing does not block the rest
   │
   ├─▶ RealtimeHandler ──▶ bus:ride-events ──▶ every API instance
   │                                              └─ EgressGuard elects
   │                                                 ONE emitter per
   │                                                 (eventId, event, audience)
   │                                              └─▶ socket room
   ├─▶ NotificationHandler ──▶ BullMQ ──▶ NotificationProcessor ──▶ FCM
   ├─▶ InAppNotificationHandler ────────────────────────────────▶ in_app_notifications
   ├─▶ DriverOfferHandler ──▶ ride-matching queue  ⚠ NO CONSUMER
   └─▶ RouteRecorderHandler ─▶ ride_events route points

   on failure: attempts++, exponential backoff capped 5min, DEAD after 8.
   A DEAD row is marked, never deleted.
```

Nothing after `COMMIT` is allowed to fail the request. That is the entire point:
`QueueProducer.send` re-throws rather than swallowing, because a swallowed error
reads as success to the relay, rows get marked `PUBLISHED`, and the retry ladder
and dead-letter state become unreachable.

### Three queues declared, one has a consumer

| Queue | Producer | Consumer | Status |
|---|---|---|---|
| `ride-notifications` | `notification.handler.ts:27` | `NotificationProcessor` | live (push) |
| `ride-matching` | `driver-offer.handler.ts:29` | — | `DRIVER_MATCHING_ENABLED=false` |
| `ride-expiry` | — | — | Redis-locked sweep instead |

The two dead entries are deliberate seams, not oversights — see
[SUBMISSION.md](SUBMISSION.md) Q11.

### Three boot shapes

`APP_ROLE` splits at the composition root (`src/config/app-role.ts`), so API
latency and queue workload scale on different axes:

| `APP_ROLE` | HTTP | Sockets | Outbox relay + queue consumers |
|---|---|---|---|
| `api` | ✓ | ✓ | — |
| `worker` | — | — | ✓ |
| `all` (default) | ✓ | ✓ | ✓ |

The worker still creates a Nest context with an unused HTTP server — without it
`onApplicationBootstrap`/`onModuleDestroy` never fire, and every deploy strands
`DEAD` rows.

### Policy is asymmetric, and lives in the backend

```
REQUESTED ──accept──▶ ACCEPTED ──start──▶ IN_PROGRESS ──complete──▶ COMPLETED
    │                      │                      │
    │                      └── driver cancel ────┴──▶ CANCELLED  (driver retained)
    └── rider cancel ──────────────────────────────▶ CANCELLED
```

A rider may cancel **only** while `REQUESTED`. Once a driver commits, only that
driver can end the trip. The legal-transition *graph* is `ride-status.ts`; the
actor/ownership *rules* are `ride-policy.ts`. Both live server-side and are
mirrored in the frontend (`cride_fend/lib/ride-status.ts`) only so a rider never
sees a button that would 409.

### Why the socket bypasses Next.js

The session is two httpOnly cookies on the API's origin. JavaScript cannot read
an httpOnly cookie, and a browser will not attach one cross-origin — so a
client-side `fetch('http://localhost:4000')` **cannot** authenticate, with any
combination of `credentials`. The Socket.IO handshake has the same constraint,
which is why it goes browser → API directly with `credentials: 'include'` while
HTTP goes through the BFF where the cookie is readable server-side.

### API surface

- 21 HTTP routes across 6 controllers — `http://localhost:4000/docs`
- Socket events: `ride:join`, `ride:leave`, `ride:sync`, `ride:transition`,
  `ride:driver_location`, `driver:availability`
- Everything authenticated is default-deny; a route is public only with `@Public()`

## Demo credentials

See `make seed-info` (defaults: `rider@cride.ng`, `driver1@cride.ng`, `driver2@cride.ng`, `driver3@cride.ng` with password `cride-demo-2026`).
