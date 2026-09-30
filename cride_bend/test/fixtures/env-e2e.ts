/**
 * Test environment, applied before any application module is imported.
 *
 * This is a `setupFiles` entry rather than something inside a test file, and the
 * ordering is load-bearing. `ConfigModule.forRoot()` is invoked by the `@Module`
 * decorator on `AppModule`, which means it runs when `app.module.ts` is *first
 * imported* — not when the Nest application is created. Anything that sets
 * `process.env` after that point is too late, because the configuration object is
 * already frozen.
 *
 * Jest loads `setupFiles` before the test file's own imports are evaluated, so
 * this is the only place a test environment can be established.
 */

/** Port chosen by POSTGRES_HOST_PORT/REDIS_HOST_PORT in the project .env. */
const PG_PORT = process.env.TEST_PG_PORT ?? '5434';
const REDIS_PORT = process.env.TEST_REDIS_PORT ?? '6380';

process.env.NODE_ENV = 'test';

// A separate database, deliberately. e2e tests truncate between cases and create
// dozens of users; pointing them at the development database would destroy the
// seeded demo data, and sharing one database between a running dev server and a
// test run makes every failure ambiguous.
process.env.DATABASE_URL = `postgresql://cride:cride@localhost:${PG_PORT}/cride_test?schema=public`;

// Redis database 1. The cache, the event bus and all three BullMQ queues live
// here, so a test run cannot evict or consume the development instance's keys and
// queued jobs. BullMQ is also unhappy on db 0, so this is the right default twice
// over.
process.env.REDIS_URL = `redis://localhost:${REDIS_PORT}/1`;

// Secrets are set explicitly rather than inherited. env.schema.ts rejects anything
// starting with `dev-only` when NODE_ENV=production, and a test that accidentally
// booted as production should fail loudly rather than silently relax.
process.env.JWT_SECRET = 'test-access-secret-value-not-dev-only';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-not-dev-only';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_TTL_DAYS = '30';

// Cost 10, the floor env.schema.ts enforces — the lowest value a build will
// accept. Lowering it here was the obvious first idea and it is the wrong one:
// the schema minimum exists to stop a deployment from shipping weak hashes, and
// relaxing it for tests would relax it for anyone who copies the block. At 10 a
// hash costs roughly 50ms, so the 20-registration accept race spends about a
// second on bcrypt. That is an acceptable price for not weakening a security
// invariant in the test harness.
process.env.BCRYPT_ROUNDS = '10';

// `all` role, not `api`. The realtime surface is driven by the outbox relay
// (§4.6/§4.8: the relay is what publishes committed events to the bus, so a
// gateway test cannot produce a single event without it). Suites that need
// deterministic outbox state freeze the relay with `freezeRelay()` and drain
// manually; suites that want live events leave it running.
//
// APP_ROLE is read when app.module.ts is first imported, so it cannot be varied
// per suite — one choice for the whole run, and the suites opt out individually.
process.env.APP_ROLE = 'all';

process.env.OTEL_ENABLED = 'false';
process.env.FCM_ENABLED = 'false';
process.env.DRIVER_MATCHING_ENABLED = 'false';
process.env.CORS_ORIGIN = 'http://localhost:3000';

// Location frames are rate-limited to one per LOCATION_MIN_INTERVAL_MS per driver
// per ride, and a driver cannot teleport more than LOCATION_MAX_JUMP_METRES. Left
// at their defaults, a test that sends three frames in a row would be told
// RATE_LIMITED and would not be testing the thing it claims to test.
process.env.LOCATION_MIN_INTERVAL_MS = '0';
process.env.LOCATION_MAX_JUMP_METRES = '1000000';

// The expiry sweep runs on a 60s interval in the `all` role, which is the role
// this whole run uses. Left alone it becomes a background actor inside the test:
// `ride-expiry.spec.ts` deliberately backdates rides, and a timer firing
// part-way through a suite would cancel them out from under the assertion — a
// flake that only appears once a run happens to cross the 60s mark. Suites that
// want the sweep drive `sweep()` themselves.
process.env.RIDE_EXPIRY_SWEEP_INTERVAL_MS = '3600000';

export {};
