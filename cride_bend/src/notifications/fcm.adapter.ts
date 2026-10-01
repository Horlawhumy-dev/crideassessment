import { Logger } from '@nestjs/common';
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { PushMessage, PushPort } from '../platform/push/push.port';
import type { DeviceTokenRepository } from './device-token.repository';

/**
 * FCM specifics that decide whether push is operable or merely present:
 *  - An invalid token is a *permanent* failure (`messaging/registration-token-not-registered`,
 *    `messaging/invalid-argument`). Retrying it is the most common cause of a push queue that
 *    can never drain, so the token is revoked on first sight.
 *  - Multicast is capped at 500 tokens per call and the SDK rejects the whole batch past that,
 *    so the input is chunked rather than truncated.
 */
export class FcmAdapter implements PushPort {
  private readonly logger = new Logger(FcmAdapter.name);
  private readonly messaging: ReturnType<typeof getMessaging> | null;

  constructor(
    private readonly devices: DeviceTokenRepository,
    projectId: string,
    clientEmail: string,
    privateKey: string,
  ) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        // A private key in an env var arrives with literal backslash-n sequences; the SDK
        // needs real newlines or it fails to parse the PEM.
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    });
    this.messaging = getMessaging();
  }

  async send(messages: readonly PushMessage[]): Promise<void> {
    for (const batch of chunk(messages, 500)) {
      if (batch.length === 0) continue;
      const first = batch[0]!;
      // sendEachForMulticast returns one result per token, in order, which is what makes it
      // possible to attribute a failure back to a specific install.
      const response = await this.messaging!.sendEachForMulticast({
        tokens: batch.map((m) => m.token),
        notification: { title: first.title, body: first.body },
        data: first.data,
      });

      response.responses.forEach((result, index) => {
        if (result.success) return;
        const code = result.error?.code ?? 'unknown';
        // One response per token, so a short array would mean the SDK and our input disagree.
        // Skip rather than guess.
        const token = batch[index]?.token;
        if (token === undefined) return;

        if (isPermanentTokenError(code)) {
          // Only a prefix is logged — the full token is a credential for that device. The
          // revoke is not awaited: bookkeeping must not turn a successful send into a failure.
          this.logger.warn('fcm.token_rejected', { code, tokenPrefix: token.slice(0, 12) });
          void this.revokeToken(token).catch(() => undefined);
        } else {
          // Transient (rate limit, internal error). Throwing lets BullMQ retry, and the dedupe
          // record keeps the retry to one visible notification.
          this.logger.warn('fcm.transient_failure', { code });
          throw new Error(`FCM transient failure: ${code}`);
        }
      });
    }
  }

  async revokeToken(token: string): Promise<void> {
    await this.devices.revoke(token);
  }
}

function isPermanentTokenError(code: string): boolean {
  return (
    code.includes('registration-token-not-registered') ||
    code.includes('invalid-argument') ||
    code.includes('invalid-registration-token')
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}
