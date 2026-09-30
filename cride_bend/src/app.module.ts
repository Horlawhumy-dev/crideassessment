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

/**
 * §4.2 — the composition root. This is the only file that knows which adapter
 * satisfies which port across the whole application, and the reason a feature
 * module can stay ignorant of infrastructure.
 *
 * Guard order is load-bearing and is set here, once, rather than per controller:
 *
 *  1. Correlation  — assigns the id every later layer logs.
 *  2. Throttle     — before authentication, so a flood costs nothing but a counter.
 *  3. JWT          — populates the Principal.
 *  4. Roles        — static role check (@Roles).
 *  5. RideAccess   — advisory only; the real check is ride-policy.ts, because a
 *                    guard that loads a ride needs a repository and turns a domain
 *                    rule into an integration test.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    ThrottlerModule.forRoot([
      // Deliberately generous: a global limit low enough to be protective on the
      // login route is also low enough to break a user opening several tabs.
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
    // ThrottlerGuard must be registered as an APP_GUARD. The @Throttle decorators
    // on the auth and write routes are inert metadata until something reads them,
    // and without this guard the tight 5-per-minute limit on /auth/login was a
    // comment rather than a control.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: RideAccessGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
