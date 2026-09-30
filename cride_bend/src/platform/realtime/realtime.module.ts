import { Global, Module } from '@nestjs/common';
import { EVENT_BUS } from './event-bus.port';
import { RedisEventBus } from './redis-event-bus';
import { EgressGuard } from './egress-guard';

/** Global: the outbox relay publishes and the ride gateways subscribe, and neither should
 * know the other exists. `EgressGuard` is exported for the same reason — both realtime
 * subscribers re-emit into a room, which the adapter fans back out to every node, so
 * without it one client-visible event arrives once per instance. */
@Global()
@Module({
  providers: [RedisEventBus, EgressGuard, { provide: EVENT_BUS, useExisting: RedisEventBus }],
  exports: [EVENT_BUS, RedisEventBus, EgressGuard],
})
export class RealtimeModule {}
