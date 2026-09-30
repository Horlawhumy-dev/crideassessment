import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RidesModule } from '../rides/rides.module';
import { LocationGateway } from './location.gateway';
import { LocationEgress } from './location.egress';
import { RedisLocationStore } from './redis-location.store';
import { LOCATION_STORE } from './location.store';
import { RouteBufferModule } from './route-buffer.module';

/**
 * Ingress (LocationGateway) and egress (LocationEgress) together. RidesModule is
 * imported for RIDE_REPOSITORY, which an export only makes visible to importers, and
 * for RidesGateway, which owns the ride rooms. The edge points tracking -> rides only.
 */
@Module({
  imports: [AuthModule, RidesModule, RouteBufferModule],
  providers: [
    LocationGateway,
    LocationEgress,
    RedisLocationStore,
    { provide: LOCATION_STORE, useExisting: RedisLocationStore },
  ],
  exports: [LOCATION_STORE],
})
export class TrackingModule {}
