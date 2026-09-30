import { Global, Module } from '@nestjs/common';
import { QueueModule } from '../platform/queue/queue.module';
import { RouteBufferModule } from '../tracking/route-buffer.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutboxRelay } from './outbox.relay';
import { OutboxRegistrar } from './outbox.registrar';
import { RealtimeHandler } from './outbox.handlers/realtime.handler';
import { NotificationHandler } from './outbox.handlers/notification.handler';
import { InAppNotificationHandler } from './outbox.handlers/in-app-notification.handler';
import { DriverOfferHandler } from './outbox.handlers/driver-offer.handler';
import { RouteRecorderHandler } from './outbox.handlers/route-recorder.handler';

/**
 * `OutboxRegistrar` is not optional: being listed as a provider instantiates a handler,
 * and only `OutboxRelay.register()` makes it reachable.
 *
 * `QueueModule` and `NotificationsModule` are imported because the handlers inject
 * `QueueProducer` and `IN_APP_NOTIFICATION_REPOSITORY`. `@Global()` makes a module's
 * providers injectable everywhere but does not make its exports resolvable, so the edge
 * still has to be declared.
 */
@Global()
@Module({
  imports: [QueueModule, RouteBufferModule, NotificationsModule],
  providers: [
    OutboxRelay,
    RealtimeHandler,
    NotificationHandler,
    InAppNotificationHandler,
    DriverOfferHandler,
    RouteRecorderHandler,
    OutboxRegistrar,
  ],
  exports: [OutboxRelay],
})
export class OutboxModule {}
