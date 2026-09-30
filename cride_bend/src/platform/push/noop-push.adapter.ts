import { Injectable, Logger } from '@nestjs/common';
import type { PushMessage, PushPort } from './push.port';

/** A missing FCM must not fail a ride transaction, and this is how that is guaranteed
 * structurally rather than by hoping a call site has a try/catch. */
@Injectable()
export class NoopPushAdapter implements PushPort {
  private readonly logger = new Logger(NoopPushAdapter.name);

  async send(messages: readonly PushMessage[]): Promise<void> {
    this.logger.warn('push.disabled', { count: messages.length });
  }

  async revokeToken(): Promise<void> {
    /* nothing to revoke without a provider */
  }
}
