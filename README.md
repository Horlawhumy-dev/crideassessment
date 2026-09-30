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

## Architecture notes (high level)

- Backend: NestJS, Prisma, Postgres, Redis, Socket.IO, BullMQ. API docs at `http://localhost:4000/docs`.
- Frontend: Next.js App Router, TypeScript, Tailwind, TanStack Query, MapLibre GL, Socket.IO client.
- Real-time: socket connects from browser directly to API using httpOnly `cride.sid` cookie (not proxied through Next).
- Policy: cancellation is asymmetric — rider cancels only `REQUESTED`; assigned driver may cancel `ACCEPTED` or `IN_PROGRESS`. Transition graph + role-aware policy live in backend (`ride-status.ts`/`ride-policy.ts`) and mirrored in frontend (`lib/ride-status.ts`).
- Live driver path: rider map accumulates `ride:driver_location_update` frames client-side (`driverPath` in ride machine/provider) and draws travelled/remaining route layers.

## Demo credentials

See `make seed-info` (defaults: `rider@cride.ng`, `driver1@cride.ng`, `driver2@cride.ng`, `driver3@cride.ng` with password `cride-demo-2026`).
