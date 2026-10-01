import { ApiProperty } from '@nestjs/swagger';
import { ERROR_REGISTRY, ERROR_CODES, type ErrorCode } from '../errors/error-codes';
import { RIDE_STATUSES } from '../../rides/domain/ride-status';
import { IN_APP_NOTIFICATION_KINDS } from '../../notifications/kinds';

/**
 * Request schemas derive from the Zod schemas that validate them (see zod-to-openapi.ts).
 * Responses have no such source, so they are declared here.
 */

/** BigInt becomes a string at exactly one place, and this is its type. */
export class MoneyDto {
  @ApiProperty({
    description: 'Amount in the smallest currency unit, as a string. 3450 is 34.50. Never a JSON number, so it cannot lose precision.',
    example: '3450',
  })
  amountMinor!: string;

  @ApiProperty({ example: 'USD' })
  currency!: string;
}

export class CoordinateDto {
  @ApiProperty({ example: 37.7749, minimum: -90, maximum: 90 })
  lat!: number;

  @ApiProperty({ example: -122.4194, minimum: -180, maximum: 180 })
  lng!: number;
}

export class RideResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RIDE_STATUSES, example: 'REQUESTED' })
  status!: (typeof RIDE_STATUSES)[number];

  @ApiProperty({
    description:
      '§4.5.2c optimistic-concurrency token. Send it back on PATCH /rides/{rideId}/status to make the write conditional. Omitting it opts into last-writer-wins.',
    example: 1,
    minimum: 1,
  })
  version!: number;

  @ApiProperty({ format: 'uuid' })
  riderId!: string;

  @ApiProperty({
    // `type: String` is required alongside nullable: `format: 'uuid'` alone emits no
    // type, which openapi-typescript renders as `Record<string, never>` — and a string
    // is not assignable to that.
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null until a driver accepts.',
  })
  driverId!: string | null;

  @ApiProperty({ type: CoordinateDto })
  pickup!: CoordinateDto;

  @ApiProperty({ type: CoordinateDto })
  dropoff!: CoordinateDto;

  @ApiProperty({ type: String, nullable: true, example: 'Ferry Building, San Francisco' })
  pickupAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  dropoffAddress!: string | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: 'Estimate computed at request time. This is not a charge and there is no payment system (§9.1).',
  })
  fare!: MoneyDto | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  acceptedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  startedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  completedAt!: string | null;

  @ApiProperty({
    type: String,
    enum: ['RIDER', 'DRIVER', 'SYSTEM'],
    nullable: true,
    description:
      'Which party ended the trip. Both the rider (before a driver accepts) and the assigned driver (after) can cancel, so this is the only way a client can tell "nobody accepted and the rider left" from "the driver dropped it".',
  })
  cancelledBy!: 'RIDER' | 'DRIVER' | 'SYSTEM' | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Free text supplied by whoever cancelled. Shown to the other party, because a bare "cancelled" is not actionable for a rider deciding whether to rebook.',
  })
  cancelReason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class RideEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    description:
      'Gapless per-ride sequence. A client tracking the highest seq it applied can detect a missed frame and resync instead of assuming none was dropped.',
    example: 2,
  })
  seq!: number;

  @ApiProperty({ example: 'ride.accepted' })
  eventType!: string;

  @ApiProperty({ enum: ['RIDER', 'DRIVER', 'SYSTEM'], nullable: true })
  actorRole!: 'RIDER' | 'DRIVER' | 'SYSTEM' | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class RideDetailResponseDto extends RideResponseDto {
  @ApiProperty({ type: [RideEventDto], description: 'Full audit trail for this ride, oldest first.' })
  events!: RideEventDto[];
}

export class RideListResponseDto {
  @ApiProperty({ type: [RideResponseDto] })
  items!: RideResponseDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque keyset cursor. Pass as ?cursor= for the next page. Null on the last page.',
  })
  nextCursor!: string | null;

  @ApiProperty({ description: 'Whether nextCursor is worth following.' })
  hasMore!: boolean;
}

/**
 * `readAt` rather than a boolean `read`: the two cannot disagree, and the timestamp
 * renders "read 2 minutes ago" free. `dedupeKey` and `userId` are absent on purpose.
 */
export class InAppNotificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: IN_APP_NOTIFICATION_KINDS,
    example: 'RIDE_ACCEPTED',
    description: 'Which ride event produced this. Derived from the same Prisma enum as the column it is stored in.',
  })
  kind!: (typeof IN_APP_NOTIFICATION_KINDS)[number];

  @ApiProperty({ example: 'Driver assigned' })
  title!: string;

  @ApiProperty({ example: 'A driver has accepted your ride and is on the way.' })
  body!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The ride this is about. Use it to link into the ride detail screen.',
  })
  rideId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Null means unread.',
  })
  readAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class InAppNotificationListResponseDto {
  @ApiProperty({ type: [InAppNotificationDto] })
  items!: InAppNotificationDto[];

  @ApiProperty({ type: String, nullable: true, description: 'Opaque keyset cursor; null on the last page.' })
  nextCursor!: string | null;

  @ApiProperty({ description: 'Whether nextCursor is worth following.' })
  hasMore!: boolean;

  @ApiProperty({
    type: Number,
    example: 3,
    description:
      'Unread across the whole inbox, not just this page. Carried here so opening the panel does not need a second request to render the badge, and so the count cannot disagree with the list it shipped beside.',
  })
  unreadCount!: number;
}

export class UnreadCountResponseDto {
  @ApiProperty({
    type: Number,
    example: 3,
    description: 'Unread entries for the caller. The bell renders from this alone, without fetching the inbox.',
  })
  unreadCount!: number;
}

export class AuthUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ example: 'Ada' })
  displayName!: string;

  @ApiProperty({ enum: ['RIDER', 'DRIVER'] })
  role!: 'RIDER' | 'DRIVER';
}

export class AuthSessionResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiProperty({
    description:
      'Also set as the httpOnly cride.sid cookie. Present in the body only because a Socket.IO handshake cannot read a cookie; the browser should rely on the cookie and ignore this.',
  })
  accessToken!: string;

  @ApiProperty({
    description: 'Access-token lifetime in seconds. Refresh before it elapses.',
    example: 900,
  })
  expiresIn!: number;
}

/** The signed-in account as the UI needs it. Never travels inside a token. */
export class SessionUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ example: 'Ada' })
  displayName!: string;

  @ApiProperty({ enum: ['RIDER', 'DRIVER'] })
  role!: 'RIDER' | 'DRIVER';

  @ApiProperty({ type: String, nullable: true, example: '+2348030000000' })
  phone!: string | null;

  @ApiProperty({
    description:
      'Driver only. Whether this driver is currently advertising themselves for new rides. Ignored for a rider.',
  })
  isAvailable!: boolean;
}

export class PrincipalDto {
  @ApiProperty({ format: 'uuid', description: 'Derived from the access token, not a body field.' })
  userId!: string;

  @ApiProperty({ enum: ['RIDER', 'DRIVER'] })
  role!: 'RIDER' | 'DRIVER';

  @ApiProperty({
    format: 'uuid',
    description: 'The refresh-token family this access token belongs to. Logout revokes the family.',
  })
  sessionId!: string;

  @ApiProperty({
    type: SessionUserDto,
    description:
      'The account behind the token, loaded server-side on each call. Present because a UI has to greet someone by name after a reload, and the JWT itself must stay free of PII — a JWT is base64, not encrypted.',
  })
  user!: SessionUserDto;
}


export class HealthResponseDto {
  @ApiProperty({ enum: ['ok', 'degraded', 'down'], example: 'ok' })
  status!: 'ok' | 'degraded' | 'down';

  @ApiProperty({ example: 128 })
  uptimeSeconds!: number;

  @ApiProperty({
    description:
      "Per-dependency state. Redis reporting 'degraded' does not fail the check: every endpoint still serves correct data from Postgres (§9 P1, §6).",
    additionalProperties: { type: 'string', enum: ['up', 'down', 'degraded'] },
    example: { database: 'up', cache: 'up' },
  })
  checks!: Record<string, 'up' | 'down' | 'degraded'>;
}

export class ValidationIssueDto {
  @ApiProperty({ example: 'pickup.lat' })
  path!: string;

  @ApiProperty({ example: 'Number must be less than or equal to 90' })
  message!: string;
}

export class ErrorResponseDto {
  @ApiProperty({ enum: ERROR_CODES, description: '§4.15. Switch on this; never string-match on message.' })
  code!: ErrorCode;

  @ApiProperty({ example: 'This ride was already accepted by another driver.' })
  message!: string;

  @ApiProperty({
    type: Object,
    nullable: true,
    additionalProperties: true,
    description: 'Field-level context. Present on validation failures as { issues: ValidationIssue[] }.',
  })
  details?: Record<string, unknown> | null;

  @ApiProperty({
    description: 'Joins this response to the log line, the trace and any queued job.',
    example: '9f1c2b4e-0a1b-4c3d-8e5f-6a7b8c9d0e1f',
  })
  correlationId!: string;

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;
}

export class ErrorEnvelopeDto {
  @ApiProperty({ type: ErrorResponseDto })
  error!: ErrorResponseDto;
}

/** Every code with its status, for the document's `Error codes` reference page. */
export const ERROR_CODE_TABLE = ERROR_CODES.map((code) => ({
  code,
  status: ERROR_REGISTRY[code].status,
  category: ERROR_REGISTRY[code].category,
  defaultMessage: ERROR_REGISTRY[code].defaultMessage,
}));
