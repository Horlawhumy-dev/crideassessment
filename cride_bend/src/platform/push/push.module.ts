import { Global, Module } from '@nestjs/common';
import { NoopPushAdapter } from './noop-push.adapter';
import { PUSH_PORT } from './push.port';

/** The FCM/no-FCM fallback. `NotificationsModule` owns the real binding, since it is the only
 * consumer with credentials to choose with; this one binds the token if nothing more specific
 * has, so any module injecting `PUSH_PORT` resolves without importing it. */
@Global()
@Module({
  providers: [{ provide: PUSH_PORT, useClass: NoopPushAdapter }],
  // Only the token is exported. `useClass` binds PUSH_PORT to the class without registering
  // NoopPushAdapter as a provider in its own right, so re-exporting the class asks Nest for
  // something this module does not own and the graph fails to scan.
  exports: [PUSH_PORT],
})
export class PushModule {}
