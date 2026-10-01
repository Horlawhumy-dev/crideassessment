import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OutboxRelay } from './outbox.relay';
import { RealtimeHandler } from './outbox.handlers/realtime.handler';
import { NotificationHandler } from './outbox.handlers/notification.handler';
import { InAppNotificationHandler } from './outbox.handlers/in-app-notification.handler';
import { DriverOfferHandler } from './outbox.handlers/driver-offer.handler';
import { RouteRecorderHandler } from './outbox.handlers/route-recorder.handler';
import type { OutboxPublisher } from './outbox.publisher';

/** `OutboxRelay.register()` is a plain method call nothing in Nest's DI graph makes, so
 * without this the relay boots with an empty publisher set and marks every message
 * PUBLISHED — a silent, permanent drop that looks exactly like success.
 * `onModuleInit`, not `onApplicationBootstrap`: the relay starts polling in the latter, which
 * Nest runs *after* every `onModuleInit`, so the first poll always sees a complete set. */
@Injectable()
export class OutboxRegistrar implements OnModuleInit {
  private readonly logger = new Logger(OutboxRegistrar.name);

  constructor(
    private readonly relay: OutboxRelay,
    private readonly realtime: RealtimeHandler,
    private readonly notifications: NotificationHandler,
    private readonly inbox: InAppNotificationHandler,
    private readonly driverOffer: DriverOfferHandler,
    private readonly routeRecorder: RouteRecorderHandler,
  ) {}

  onModuleInit(): void {
    const handlers: OutboxPublisher[] = [
      this.realtime,
      this.notifications,
      this.inbox,
      this.driverOffer,
      this.routeRecorder,
    ];

    for (const handler of handlers) {
      this.relay.register(handler);
    }

    this.logger.log('outbox.handlers_registered', {
      count: handlers.length,
      handlers: handlers.map((h) => h.constructor.name),
    });
  }
}
