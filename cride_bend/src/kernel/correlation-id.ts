import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-request-id';

const MAX_LENGTH = 128;

/**
 * One id joining logs, spans, events, the outbox and the bus. A client-supplied
 * value is honoured but validated: an unvalidated header echoed into every log
 * line is a log-injection vector.
 */
export function resolveCorrelationId(incoming: unknown): string {
  if (typeof incoming === 'string') {
    const trimmed = incoming.trim();
    if (
      trimmed.length > 0 &&
      trimmed.length <= MAX_LENGTH &&
      /^[A-Za-z0-9._:-]+$/.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return randomUUID();
}
