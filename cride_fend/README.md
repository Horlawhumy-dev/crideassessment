# CRide Web (Frontend)

Next.js (App Router) frontend for CRide. It talks to the NestJS API over HTTP (server-side routes via `/api/[...path]` proxy) and directly over Socket.IO from the browser using the httpOnly `cride.sid` session cookie.

## Quick start

The simplest way is from the repo root using the Makefile:

```bash
# Start Postgres, Redis, migrate + seed, and install deps
make setup

# Run API (4000) and web (3000) together
make dev
```

Then open [http://localhost:3000](http://localhost:3000).

Sign in with one of the seeded accounts: `make seed-info`.

## Environment variables

**No `.env` is needed for local development.** Both variables fall back to
`http://localhost:4000`, which is where `make dev-api` listens, so `npm run dev` works
against a default setup with no file to create. Copy `.env.example` to `.env` only when
you need to point the app at an API somewhere else:

```bash
cp .env.example .env
```

| Variable | Used where | Purpose | Default |
|---|---|---|---|
| `API_URL` | Server-side (Next.js route handlers under `app/api/[...path]`) | Origin the Next server uses to call the NestJS API. Never exposed to the browser. | `http://localhost:4000` |
| `NEXT_PUBLIC_API_URL` | Browser | Origin the browser opens a Socket.IO connection against. **The WebSocket handshake is NOT proxied through Next** — it goes straight to the API and authenticates with the httpOnly `cride.sid` cookie. | `http://localhost:4000` |

> The socket client reads `NEXT_PUBLIC_API_URL` directly rather than a relative `/api`
> path. See `lib/realtime/socket.ts` and `app/api/[...path]/route.ts`.

## Prerequisites

- Node.js 20+ and npm (repo uses Node 24/npm 11)
- Running CRide API on `http://localhost:4000` (via `make dev-api` or `node dist/main` after build)
- Postgres + Redis (via `docker compose` in `cride_bend/` or `make up`)

## Scripts

```bash
npm run dev         # Next dev on http://localhost:3000
npm run build       # Production build
npm run start       # Start production server
npm run typecheck   # tsc --noEmit
npm run test        # Vitest run (unit tests)
npm run test:watch  # Vitest watch
npm run gen:api     # Regenerate lib/generated/api.d.ts from running API (/docs-json)
npm run check:api   # Fail if running API spec drifts from generated types
npm run check:styles# Enforce no arbitrary Tailwind colors
npm run verify      # typecheck + check:styles + test + build
npm run verify:live # verify + check:api (requires running API)
```

## API contract types

The TypeScript client types are generated from the NestJS OpenAPI document. They live in `lib/generated/api.d.ts` (gitignored) and are consumed via `lib/api/client.ts` and `lib/types.ts`.

**Workflow:**

1. Start the API (`make dev-api` or ensure `http://localhost:4000/docs-json` is reachable)
2. Regenerate types: `npm run gen:api`
3. Review the diff before committing (a contract change is deliberate)
4. Verify in CI/dev: `npm run check:api` (expects the running API to match generated types)

If the API was rebuilt/restarted after changing backend DTOs/schemas, always regenerate types. A stale API process (e.g. `node dist/main` from an older build) will emit an old spec.

## Architecture notes (relevant to setup)

- **Server proxy**: `app/api/[...path]/route.ts` forwards non-WebSocket requests to `API_URL`. This keeps secrets (if any) server-side and normalizes errors.
- **Realtime**: Socket.IO connects from the browser to `NEXT_PUBLIC_API_URL` with credentials enabled (httpOnly cookie). The gateway uses the same auth/session as HTTP.
- **State**: Ride state machine lives in `lib/rides/machine.ts` and is driven by `ride:status_changed` frames. See tests in `tests/rides/machine.test.ts`.
- **Policy mirror**: `lib/ride-status.ts` mirrors backend policy (e.g. which roles can cancel in which states). UI never invents transitions not permitted there.
- **Map**: `MapView` uses MapLibre GL. CSS is loaded as a stylesheet (not `rel="preload" as="style"`) in `lib/map/maplibre-view.tsx`. MapLibre emits `error` events on WebGL failures rather than throwing synchronously — the component listens for both constructor errors and the `error` event to avoid a stuck “Loading map…” state.

## Testing & verification

- Unit tests: Vitest (`tests/`). Key areas: ride machine (driver path accumulation, resync), `allowedActions` policy, core utilities.
- Style guard: `scripts/check-no-arbitrary-colors.mjs` prevents ad-hoc hex/HSL in Tailwind classes.
- Full gate: `npm run verify` runs typecheck, style check, tests, and a production build (Turbopack). `npm run verify:live` also checks API contract drift.

All frontend checks pass in the current state (60 unit tests, typecheck clean, production build succeeds).

## Development tips

- When backend adds/changes `cancelledBy`/`cancelReason` (or any DTO), regenerate API types (`gen:api`) and update any derived types/tests.
- Driver availability: toggling online calls the REST endpoint and then `syncAvailability()` so the socket joins/leaves `drivers:available` immediately (no page reload needed). New ride offers dispatch `cride:offer` on window and the driver screen invalidates the available rides list.
- Driver cancellation: `allowedActions` includes `CANCELLED` for `ACCEPTED`/`IN_PROGRESS` drivers; `RideCard` renders the Cancel action only if an `onCancel` handler is provided; the driver screen prompts for a reason and calls `useRideTransitions().cancel()` (which sends versioned `PATCH /rides/:id/status` with `to: 'CANCELLED'`).
