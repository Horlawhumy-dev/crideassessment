import type { ErrorCode, ErrorEnvelope, ValidationIssue } from '../types';

/**
 * §4.15 — one error type, switchable on `code`.
 *
 * The previous app had no error type at all: `lib/api.ts` returned
 * `Promise<any>` and every caller reached for a string. That is why the
 * dashboard rendered an empty state on a 500, why a rate-limited login showed
 * "invalid credentials", and why nothing could distinguish a retryable outage
 * from a permanent refusal.
 *
 * Everything a screen needs in order to decide what to *say* is on this object.
 * Nothing needs to parse a message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE';
  readonly correlationId: string | null;
  readonly details: unknown;

  constructor(init: {
    status: number;
    code: ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE';
    message: string;
    correlationId?: string | null;
    details?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.correlationId = init.correlationId ?? null;
    this.details = init.details ?? null;
  }

  /**
   * A validation failure, with the field-level issues the backend sent.
   * The form reads `issues`; the screen never has to map a message back to a key.
   */
  get isValidation(): boolean {
    return this.code === 'MISSING_FIELD';
  }

  get validationIssues(): ValidationIssue[] {
    const issues = (this.details as { issues?: unknown } | null)?.issues;
    return Array.isArray(issues) ? (issues as ValidationIssue[]) : [];
  }

  /** §4.9: a version conflict. The caller must refetch and reconcile, not retry. */
  get isVersionConflict(): boolean {
    return this.code === 'RIDE_VERSION_CONFLICT';
  }

  /** The session is gone or expired. A 401 from `/auth/me` means "log in", nothing else. */
  get isUnauthenticated(): boolean {
    return this.status === 401 || this.code === 'TOKEN_EXPIRED' || this.code === 'TOKEN_REVOKED';
  }

  /** Expected under concurrency: another driver won the offer. Not an error to apologise for. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** The ride is not the caller's to act on, or not visible to them. */
  get isForbidden(): boolean {
    return this.code === 'FORBIDDEN_ROLE' || this.code === 'RIDE_NOT_VISIBLE' || this.code === 'NOT_ASSIGNED_DRIVER';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.code === 'RATE_LIMITED' || this.status === 429;
  }

  /** The request never reached the API, or the answer never came back. Retryable. */
  get isNetwork(): boolean {
    return this.code === 'NETWORK_ERROR';
  }

  /** A 5xx, or a dependency that is down. Retryable, and worth saying so plainly. */
  get isTransient(): boolean {
    return this.isNetwork || this.status >= 500;
  }

  /**
   * Something a person can act on. Deliberately generic: a real screen shows
   * this, and the specifics go to the correlation id.
   */
  get displayMessage(): string {
    if (this.isNetwork) return 'Cannot reach C-Ride. Check your connection and try again.';
    if (this.code === 'RATE_LIMITED') return 'Too many attempts. Wait a minute and try again.';
    if (this.code === 'INVALID_CREDENTIALS') return 'That email and password do not match an account.';
    if (this.isForbidden) return 'You do not have access to that.';
    if (this.isNotFound) return 'We could not find that.';
    if (this.status >= 500) return 'C-Ride is having trouble. Please try again in a moment.';
    if (this.isConflict) return 'That changed a moment ago. We have refreshed the latest version.';
    return this.message || 'Something went wrong.';
  }

  /** Enough to reproduce a bug, without inventing detail. */
  get debugHint(): string | null {
    return this.correlationId ? `Reference: ${this.correlationId}` : null;
  }

  static from(status: number, body: unknown): ApiError {
    const envelope = body as Partial<ErrorEnvelope> | null;
    const error = envelope?.error;

    if (error && typeof error.code === 'string') {
      return new ApiError({
        status,
        code: error.code as ErrorCode,
        message: typeof error.message === 'string' ? error.message : 'Request failed.',
        correlationId: error.correlationId ?? null,
        details: error.details ?? null,
      });
    }

    // A 200-shaped body with no envelope, or a 502 from something in front of
    // the API. Still an ApiError, so callers have exactly one thing to catch.
    return new ApiError({
      status,
      code: 'UNEXPECTED_RESPONSE',
      message: `Unexpected response (${status}).`,
    });
  }

  static network(cause: unknown): ApiError {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: `Request failed: ${reason}`,
    });
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
