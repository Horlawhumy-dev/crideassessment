import { INestApplication } from '@nestjs/common';
import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { HttpFactory } from './http';
import { AppModule } from '../../src/app.module';
import { RedisIoAdapter } from '../../src/platform/realtime/redis-io.adapter';
import { RedisClient } from '../../src/platform/cache/redis.client';
import { PrismaService } from '../../src/platform/prisma/prisma.service';
import { OutboxRelay } from '../../src/outbox/outbox.relay';

export interface TestApp {
  app: INestApplication;
  moduleRef: TestingModule;
  prisma: PrismaService;
  redis: RedisClient;
  http: HttpFactory;
  /** Bound address, needed by socket.io-client. */
  url: string;
  close: () => Promise<void>;
}

/**
 * A throttler that records nothing.
 *
 * The suite authenticates tens of users, and `/auth/register` and `/auth/login`
 * carry a deliberate 5-per-minute limit as the primary credential-stuffing
 * control. That control is real and is tested for real — in `throttle.spec.ts`,
 * with the real storage. Everywhere else it is pure interference: the twentieth
 * test user gets a 429 and the failure reads like a bug in whatever the test was
 * actually about.
 *
 * The override targets the *storage*, not the guard. Two reasons. First,
 * `overrideGuard` silently does nothing for a guard bound through `APP_GUARD`,
 * which is how `ThrottlerGuard` is registered here — it appeared to work and
 * 429'd anyway. Second, replacing only the storage keeps the real `ThrottlerGuard`
 * running, so `@SkipThrottle`, the `@Throttle` metadata and the guard's own
 * control flow are all still exercised; only the counting is neutered.
 *
 * Reporting `totalHits: 0` rather than throwing is the simplest way to stay under
 * every limit. It leaves the production values hard-coded where they belong. A
 * limit that can be raised by an environment variable is a limit that will be
 * raised by accident.
 */
class UnlimitedThrottlerStorage implements ThrottlerStorage {
  async increment(): Promise<ThrottlerStorageRecord> {
    return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
  }
}

export async function createTestApp(options: { throttle?: boolean } = {}): Promise<TestApp> {
  let builder: TestingModuleBuilder = Test.createTestingModule({ imports: [AppModule] });

  if (options.throttle !== true) {
    builder = builder.overrideProvider(ThrottlerStorage).useClass(UnlimitedThrottlerStorage);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();

  // Mirrors main.ts exactly. The point of an e2e suite that builds the real
  // AppModule is that a wiring mistake fails here rather than in a demo; a
  // "simplified" test application would have hidden four of them already.
  app.use(cookieParser());
  app.enableCors({ origin: ['http://localhost:3000'], credentials: true });
  app.useWebSocketAdapter(new RedisIoAdapter(app, app.get(RedisClient)));
  app.enableShutdownHooks();

  // Port 0: an ephemeral port, so suites can run concurrently and so a stale
  // process on 4000 cannot make a failure look like a pass.
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();

  return {
    app,
    moduleRef,
    prisma: app.get(PrismaService),
    redis: app.get(RedisClient),
    http: () => request(url),
    url,
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Stops the outbox relay's background poll, leaving `drainOnce()` callable.
 *
 * The relay is started because the realtime surface depends on it, and its poll
 * runs every 250ms. For a suite that asserts on outbox rows, that poll is a race:
 * a row could be dispatched and marked PUBLISHED between the write and the
 * assertion, and the failure would report as "expected PENDING, got PUBLISHED" on
 * a test that never touched the relay.
 *
 * `onModuleDestroy` is the existing public method that does exactly this — it
 * sets `running = false`, clears the interval and awaits whatever drain is in
 * flight. Calling it here is a misuse of the name, and it is the right call
 * anyway: the alternative was a production `pause()` that exists only for tests.
 */
export function freezeRelay(app: INestApplication): void {
  app.get(OutboxRelay).onModuleDestroy();
}

/**
 * Truncates every table and flushes Redis between test cases.
 *
 * TRUNCATE ... CASCADE rather than DELETE: DELETE is one statement per table and
 * leaves the sequences running, so ids differ between runs and a test that asserts
 * on ordering has to be careful. TRUNCATE resets both, in one statement, and
 * CASCADE clears the children without remembering the order.
 */
export async function resetDatabase(prisma: PrismaService, redis?: RedisClient): Promise<void> {
  // Table order is load-bearing, not cosmetic. A single TRUNCATE takes
  // ACCESS EXCLUSIVE locks in the order it is written, and the outbox relay
  // running in this same process (APP_ROLE=all) takes RowExclusive locks in
  // dependency order: it updates `outbox_messages` before inserting into
  // `in_app_notifications`. Listing the two the other way round here produced a
  // real deadlock — 40P01, "process A waits for AccessExclusiveLock on
  // in_app_notifications, blocked by B; B waits for RowExclusiveLock on
  // outbox_messages, blocked by A" — which surfaced as FK violations on
  // rides_riderId_fkey, because the truncating transaction rolled back and left
  // every row from the previous suite in place.
  //
  // Acquiring in the same order the relay does means one of the two waits
  // without a cycle, so the truncate simply runs after the in-flight poll.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "outbox_messages", "in_app_notifications", "notification_deliveries", "ride_events", ' +
      '"route_points", "idempotency_keys", "rides", "refresh_tokens", "device_tokens", "users" ' +
      'RESTART IDENTITY CASCADE',
  );

  if (redis) {
    // Cache keys and rate-limit claims are derived from ids that are about to be
    // reused. A stale `ride:loc:<id>` from the previous test would be read as the
    // driver's last known position and would make a new driver look like it
    // teleported.
    await redis.client.flushdb();
  }
}
