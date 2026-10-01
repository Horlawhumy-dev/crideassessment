import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { configuration } from './config/configuration';
import { PrismaModule } from './platform/prisma/prisma.module';
import { CacheModule } from './platform/cache/cache.module';
import { QueueModule } from './platform/queue/queue.module';
import { PushModule } from './platform/push/push.module';
import { RealtimeModule } from './platform/realtime/realtime.module';
import { TelemetryModule } from './platform/otel/telemetry.module';
import { HealthModule } from './platform/health/health.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RidesModule } from './rides/rides.module';
import { DriverModule } from './driver/driver.module';
import { TrackingModule } from './tracking/tracking.module';
import { OutboxModule } from './outbox/outbox.module';
import { NotificationsModule } from './notifications/notifications.module';
import { JwtAuthGuard } from './common/guards/jwt.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RideAccessGuard } from './common/guards/ride-access.guard';
import { CorrelationInterceptor } from './common/interceptors/correlation.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PrismaErrorFilter } from './platform/prisma/prisma-error.filter';

/** The composition root: the only file that knows which adapter satisfies which port.
 * Guard order is set here, once, and is deliberate — `ThrottlerGuard` runs BEFORE
 * `JwtAuthGuard` so a credential flood costs a counter, not a bcrypt call. `RideAccessGuard`
 * is advisory only; the real check is ride-policy.ts, because a guard that loads a ride needs
 * a repository and turns a domain rule into an integration test. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    ThrottlerModule.forRoot([
      // Deliberately generous: a global limit low enough to be protective on the login
      // route is also low enough to break a user opening several tabs.
      { name: 'default', ttl: 60_000, limit: 120 },
    ]),
    ScheduleModule.forRoot(),
    TelemetryModule,
    PrismaModule,
    CacheModule,
    QueueModule,
    PushModule,
    RealtimeModule,
    UsersModule,
    AuthModule,
    RidesModule,
    DriverModule,
    TrackingModule,
    OutboxModule,
    NotificationsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    // Must be an APP_GUARD: the `@Throttle` decorators are inert metadata until something
    // reads them, and without it the 5-per-minute limit on /auth/login is a comment.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: RideAccessGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Registered *after* the catch-all, which is what makes it effective: Nest reverses the
    // global filter list before matching and takes the first hit, and `AllExceptionsFilter` is
    // `@Catch()` with no metatypes. Reversing these two lines makes this filter dead code.
    { provide: APP_FILTER, useClass: PrismaErrorFilter },
  ],
})
export class AppModule {}
