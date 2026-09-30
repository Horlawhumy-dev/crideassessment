import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DriverModule } from '../driver/driver.module';
import { RidesController } from './rides.controller';
import { RidesGateway } from './rides.gateway';
import { AcceptRideUseCase } from './application/accept-ride.use-case';
import { GetRideUseCase } from './application/get-ride.use-case';
import { ListRidesUseCase } from './application/list-rides.use-case';
import { RequestRideUseCase } from './application/request-ride.use-case';
import { TransitionRideUseCase } from './application/transition-ride.use-case';
import { FARE_POLICY, FarePolicyProvider } from './application/fare-policy.provider';
import { RideExpiryScheduler } from './application/ride-expiry.scheduler';
import { RideExpiryTimer } from './ride-expiry.timer';
import { PrismaRideRepository } from './infrastructure/prisma-ride.repository';
import { RedisRideCacheAdapter } from './infrastructure/redis-ride-cache.adapter';
import { PrismaOutboxAdapter } from './infrastructure/prisma-outbox.adapter';
import { PrismaRideEventRepository } from './infrastructure/prisma-ride-event.repository';
import { RIDE_REPOSITORY } from './application/ports/ride.repository';
import { RIDE_CACHE_PORT } from './application/ports/ride-cache.port';
import { OUTBOX_PORT } from './application/ports/outbox.port';
import { RIDE_EVENTS_PORT } from './application/ports/ride-events.port';
import type { FarePolicy } from './domain/fare';

/**
 * §4.2 — the wiring is the enforcement. `rides` declares ports; the adapters
 * that satisfy them are bound here and nowhere else. It does not import
 * `notifications` or `queues`, because it does not know push exists.
 */
@Module({
  imports: [forwardRef(() => AuthModule), DriverModule],
  controllers: [RidesController],
  providers: [
    RequestRideUseCase,
    AcceptRideUseCase,
    TransitionRideUseCase,
    GetRideUseCase,
    ListRidesUseCase,
    RidesGateway,
    PrismaRideRepository,
    RedisRideCacheAdapter,
    PrismaOutboxAdapter,
    PrismaRideEventRepository,
    FarePolicyProvider,
    { provide: FARE_POLICY, useFactory: (p: FarePolicyProvider): FarePolicy => p.policy, inject: [FarePolicyProvider] },
    RideExpiryScheduler,
    RideExpiryTimer,
    { provide: RIDE_REPOSITORY, useExisting: PrismaRideRepository },
    { provide: RIDE_CACHE_PORT, useExisting: RedisRideCacheAdapter },
    { provide: OUTBOX_PORT, useExisting: PrismaOutboxAdapter },
    { provide: RIDE_EVENTS_PORT, useExisting: PrismaRideEventRepository },
  ],
  exports: [RIDE_REPOSITORY, RIDE_CACHE_PORT, OUTBOX_PORT, RIDE_EVENTS_PORT, RidesGateway],
})
export class RidesModule {}
