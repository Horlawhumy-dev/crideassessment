import { ERROR_REGISTRY, type ErrorCode, type ErrorCategory } from './error-codes';

/**
 * The only error type the application and domain layers may throw; anything else is
 * logged with its cause and answered generically. `details` is field-level for
 * validation and never a stack trace.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_REGISTRY[code].defaultMessage);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  get status(): number {
    return ERROR_REGISTRY[this.code].status;
  }

  get category(): ErrorCategory {
    return ERROR_REGISTRY[this.code].category;
  }

  /** Safe to serialise to a client. Never includes a cause or a stack. */
  toJSON(): {
    error: {
      code: ErrorCode;
      message: string;
      details?: Record<string, unknown>;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class ValidationError extends DomainError {
  constructor(code: Extract<ErrorCode, `${string}`> = 'MISSING_FIELD', details?: Record<string, unknown>) {
    super(code, undefined, details);
  }
}

export class InvalidCoordinatesError extends DomainError {
  constructor(lat: unknown, lng: unknown) {
    super('INVALID_COORDINATES', undefined, { lat, lng });
  }
}

export class InvalidCursorError extends DomainError {
  constructor() {
    super('INVALID_CURSOR');
  }
}

export class AuthError extends DomainError {
  constructor(
    code:
      | 'INVALID_CREDENTIALS'
      | 'TOKEN_EXPIRED'
      | 'TOKEN_REVOKED'
      | 'INVALID_REFRESH_TOKEN'
      | 'MISSING_TOKEN',
  ) {
    super(code);
  }
}

export class ForbiddenRoleError extends DomainError {
  constructor(role: string) {
    super('FORBIDDEN_ROLE', undefined, { role });
  }
}

/**
 * Maps to 404 deliberately: telling a user a ride exists when they cannot see it
 * is an enumeration oracle.
 */
export class RideNotVisibleError extends DomainError {
  constructor(rideId: string) {
    super('RIDE_NOT_VISIBLE', undefined, { rideId });
  }
}

export class NotAssignedDriverError extends DomainError {
  constructor(rideId: string) {
    super('NOT_ASSIGNED_DRIVER', undefined, { rideId });
  }
}

export class RideAlreadyAcceptedError extends DomainError {
  constructor(rideId: string) {
    super('RIDE_ALREADY_ACCEPTED', undefined, { rideId });
  }
}

export class RideNotAcceptableError extends DomainError {
  constructor(rideId: string, status: string) {
    super('RIDE_NOT_ACCEPTABLE', undefined, { rideId, status });
  }
}

export class RideVersionConflictError extends DomainError {
  constructor(rideId: string, expected: number, actual: number) {
    super('RIDE_VERSION_CONFLICT', undefined, { rideId, expected, actual });
  }
}

export class RiderHasActiveRideError extends DomainError {
  constructor(riderId: string, rideId: string) {
    super('RIDER_ALREADY_HAS_ACTIVE_RIDE', undefined, { riderId, rideId });
  }
}

export class IdempotencyInProgressError extends DomainError {
  constructor(key: string) {
    super('IDEMPOTENCY_IN_PROGRESS', undefined, { key });
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  constructor(key: string) {
    super('IDEMPOTENCY_KEY_REUSED', undefined, { key });
  }
}

export class RideNotFoundError extends DomainError {
  constructor(rideId: string) {
    super('RIDE_NOT_FOUND', undefined, { rideId });
  }
}

export class UserNotFoundError extends DomainError {
  constructor(identifier: string) {
    super('USER_NOT_FOUND', undefined, { identifier });
  }
}

/**
 * Thrown both when the inbox id is nobody's and when it is another user's, on purpose:
 * a distinct "exists but not yours" answer lets a caller walk ids and learn who has
 * which notifications.
 */
export class NotificationNotFoundError extends DomainError {
  constructor(notificationId: string) {
    super('NOTIFICATION_NOT_FOUND', undefined, { notificationId });
  }
}
