import { Module } from '@nestjs/common';
import { RedisRouteBuffer } from './redis-route-buffer';
import { ROUTE_BUFFER } from './route-buffer.port';

/**
 * Its own leaf module: TrackingModule appends and OutboxModule drains, and registering
 * the buffer in either would force the other to import it — putting it in TrackingModule
 * gives the worker process the ride write use-cases. No imports: RedisClient is @Global.
 */
@Module({
  providers: [RedisRouteBuffer, { provide: ROUTE_BUFFER, useExisting: RedisRouteBuffer }],
  exports: [ROUTE_BUFFER],
})
export class RouteBufferModule {}