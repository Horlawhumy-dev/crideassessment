import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { PUSH_PORT } from '../platform/push/push.port';
import { NoopPushAdapter } from '../platform/push/noop-push.adapter';
import { FcmAdapter } from './fcm.adapter';
import { NotificationDedupe } from './dedupe';
import {
  DEVICE_TOKEN_REPOSITORY,
  PrismaDeviceTokenRepository,
  type DeviceTokenRepository,
} from './device-token.repository';
import { NotificationProcessor } from './notification.processor';
import { DevicesController } from './devices.controller';
import { NotificationsController } from './notifications.controller';
import {
  IN_APP_NOTIFICATION_REPOSITORY,
  PrismaInAppNotificationRepository,
} from './in-app.repository';

/**
 * Owns the PUSH_PORT binding, overriding the no-op fallback in platform/push/push.module.ts
 * when FCM credentials are present. `NotificationProcessor` is instantiated in both roles
 * rather than worker-only: the queue is empty in the API role, so an idle consumer costs
 * nothing. `OutboxModule` imports this module to reach `IN_APP_NOTIFICATION_REPOSITORY`;
 * `notifications` imports nothing from `outbox`, so that edge is not a cycle.
 */
@Module({
  controllers: [DevicesController, NotificationsController],
  providers: [
    NotificationDedupe,
    NotificationProcessor,
    PrismaDeviceTokenRepository,
    { provide: DEVICE_TOKEN_REPOSITORY, useExisting: PrismaDeviceTokenRepository },
    PrismaInAppNotificationRepository,
    { provide: IN_APP_NOTIFICATION_REPOSITORY, useExisting: PrismaInAppNotificationRepository },
    {
      provide: PUSH_PORT,
      // The repository is passed explicitly rather than injected into FcmAdapter: it is
      // built by a factory, so a constructor decorator would never resolve.
      inject: [ConfigService, DEVICE_TOKEN_REPOSITORY],
      useFactory: (
        config: ConfigService,
        devices: DeviceTokenRepository,
      ): NoopPushAdapter | FcmAdapter => {
        const cfg = config.get<AppConfig>(APP_CONFIG)!;
        if (!cfg.FCM_ENABLED) return new NoopPushAdapter();
        return new FcmAdapter(
          devices,
          cfg.FIREBASE_PROJECT_ID!,
          cfg.FIREBASE_CLIENT_EMAIL!,
          cfg.FIREBASE_PRIVATE_KEY!,
        );
      },
    },
  ],
  exports: [NotificationDedupe, DEVICE_TOKEN_REPOSITORY, IN_APP_NOTIFICATION_REPOSITORY, PUSH_PORT],
})
export class NotificationsModule {}
