/**
 * The error contract's single source of truth; clients switch on `code`, never on
 * `message`. The Record<ErrorCode, ErrorMeta> shape makes a missing status a compile error.
 */
export const ERROR_CODES = [
  'INVALID_COORDINATES',
  'FARE_NOT_COMPUTABLE',
  'INVALID_TRANSITION',
  'WRONG_ACTOR_FOR_TRANSITION',
  'MISSING_FIELD',
  'INVALID_CURSOR',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_KEY_REUSED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'INVALID_REFRESH_TOKEN',
  'MISSING_TOKEN',
  'FORBIDDEN_ROLE',
  'RIDE_NOT_VISIBLE',
  'NOT_ASSIGNED_DRIVER',
  'RIDE_ALREADY_ACCEPTED',
  'RIDE_NOT_ACCEPTABLE',
  'RIDE_VERSION_CONFLICT',
  'RIDER_ALREADY_HAS_ACTIVE_RIDE',
  'RIDE_NOT_FOUND',
  'USER_NOT_FOUND',
  'NOTIFICATION_NOT_FOUND',
  'DATABASE_UNAVAILABLE',
  'CACHE_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorCategory =
  | 'VALIDATION'
  | 'AUTHN'
  | 'AUTHZ'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'SYSTEM';

interface ErrorMeta {
  readonly status: number;
  readonly category: ErrorCategory;
  readonly defaultMessage: string;
}

export const ERROR_REGISTRY: Record<ErrorCode, ErrorMeta> = {
  INVALID_COORDINATES: {
    status: 400,
    category: 'VALIDATION',
    defaultMessage: 'Coordinates are out of range.',
  },
  FARE_NOT_COMPUTABLE: {
    status: 400,
    category: 'VALIDATION',
    defaultMessage: 'A fare could not be computed for this trip.',
  },
  INVALID_TRANSITION: {
    status: 409,
    category: 'CONFLICT',
    defaultMessage: 'That status change is not allowed.',
  },
  WRONG_ACTOR_FOR_TRANSITION: {
    status: 403,
    category: 'AUTHZ',
    defaultMessage: 'Your role cannot make that status change.',
  },
  MISSING_FIELD: {
    status: 400,
    category: 'VALIDATION',
    defaultMessage: 'A required field is missing.',
  },
  INVALID_CURSOR: {
    status: 400,
    category: 'VALIDATION',
    defaultMessage: 'The pagination cursor is not valid.',
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    category: 'CONFLICT',
    defaultMessage: 'An identical request is still being processed.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    category: 'VALIDATION',
    defaultMessage: 'That idempotency key was used for a different request.',
  },
  INVALID_CREDENTIALS: {
    status: 401,
    category: 'AUTHN',
    defaultMessage: 'Email or password is incorrect.',
  },
  TOKEN_EXPIRED: {
    status: 401,
    category: 'AUTHN',
    defaultMessage: 'Your session has expired.',
  },
  TOKEN_REVOKED: {
    status: 401,
    category: 'AUTHN',
    // A token that was real was consumed or its family revoked: the theft signal
    // auth.service warns on. Never-issued tokens use INVALID_REFRESH_TOKEN.
    defaultMessage: 'Your session has been revoked.',
  },
  INVALID_REFRESH_TOKEN: {
    status: 401,
    category: 'AUTHN',
    // "Never issued by us", kept distinct from TOKEN_REVOKED so it does not read as theft.
    defaultMessage: 'The refresh token is invalid or has expired.',
  },
  MISSING_TOKEN: {
    status: 401,
    category: 'AUTHN',
    defaultMessage: 'Authentication is required.',
  },
  FORBIDDEN_ROLE: {
    status: 403,
    category: 'AUTHZ',
    defaultMessage: 'Your role does not permit this action.',
  },
  RIDE_NOT_VISIBLE: {
    status: 404,
    category: 'AUTHZ',
    // 404, not 403: a 403 confirms the ride exists, an enumeration oracle.
    defaultMessage: 'Ride not found.',
  },
  NOT_ASSIGNED_DRIVER: {
    status: 403,
    category: 'AUTHZ',
    defaultMessage: 'You are not the driver assigned to this ride.',
  },
  RIDE_ALREADY_ACCEPTED: {
    status: 409,
    category: 'CONFLICT',
    defaultMessage: 'This ride was already accepted by another driver.',
  },
  RIDE_NOT_ACCEPTABLE: {
    status: 409,
    category: 'CONFLICT',
    defaultMessage: 'This ride is no longer available.',
  },
  RIDE_VERSION_CONFLICT: {
    status: 409,
    category: 'CONFLICT',
    defaultMessage: 'This ride changed since you last loaded it.',
  },
  RIDER_ALREADY_HAS_ACTIVE_RIDE: {
    status: 409,
    category: 'CONFLICT',
    defaultMessage: 'You already have a ride in progress.',
  },
  RIDE_NOT_FOUND: {
    status: 404,
    category: 'NOT_FOUND',
    defaultMessage: 'Ride not found.',
  },
  USER_NOT_FOUND: {
    status: 404,
    category: 'NOT_FOUND',
    defaultMessage: 'User not found.',
  },
  NOTIFICATION_NOT_FOUND: {
    status: 404,
    category: 'NOT_FOUND',
    // Also the answer for "that notification is not yours": a distinct 403 would
    // confirm the id exists in somebody else's inbox.
    defaultMessage: 'Notification not found.',
  },
  DATABASE_UNAVAILABLE: {
    status: 503,
    category: 'SYSTEM',
    defaultMessage: 'The service is temporarily unavailable.',
  },
  CACHE_UNAVAILABLE: {
    status: 503,
    category: 'SYSTEM',
    defaultMessage: 'The service is temporarily unavailable.',
  },
  RATE_LIMITED: {
    status: 429,
    category: 'SYSTEM',
    defaultMessage: 'Too many requests. Please slow down.',
  },
  INTERNAL_ERROR: {
    status: 500,
    category: 'SYSTEM',
    defaultMessage: 'Something went wrong.',
  },
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_REGISTRY;
}

export function statusForCode(code: ErrorCode): number {
  return ERROR_REGISTRY[code].status;
}
