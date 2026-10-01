import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { configuration } from './config/configuration';
import { PrismaModule } from './platform/prisma/prisma.module';
import { CacheModule } from './platform/cache/cache.module';
import { QueueModule } from './platform/queue/queue.module';
import { RealtimeModule } from './platform/realtime/realtime.module';
import { TelemetryModule } from './platform/otel/telemetry.module';
import { OutboxModule } from './outbox/outbox.module';
import { NotificationsModule } from './notifications/notifications.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/** No controllers, no HTTP server, no ride write use-cases. A worker that could accept a ride
 * is a worker that can race the API process for the same row. It does have the outbox relay
 * and the queue consumers, both consumers, which is the correct shape for a process whose
 * latency profile is unrelated to request latency. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    ScheduleModule.forRoot(),
    TelemetryModule,
    PrismaModule,
    CacheModule,
    QueueModule,
    RealtimeModule,
    UsersModule,
    AuthModule,
    OutboxModule,
    NotificationsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class WorkerModule {}
