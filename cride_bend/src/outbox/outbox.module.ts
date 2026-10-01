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

/** `OutboxRegistrar` is not optional: listing a handler as a provider only instantiates it,
 * and only `OutboxRelay.register()` makes it reachable. `QueueModule`/`NotificationsModule`
 * are imported because the handlers inject `QueueProducer` and
 * `IN_APP_NOTIFICATION_REPOSITORY` — `@Global()` makes providers injectable everywhere but
 * does not make an export resolvable, so the edge still has to be declared. */
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
