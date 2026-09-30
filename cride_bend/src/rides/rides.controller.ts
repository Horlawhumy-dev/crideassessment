import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CorrelationId } from '../common/decorators/correlation-id.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AcceptRideUseCase } from './application/accept-ride.use-case';
import { GetRideUseCase } from './application/get-ride.use-case';
import { ListRidesUseCase } from './application/list-rides.use-case';
import { RequestRideUseCase } from './application/request-ride.use-case';
import { TransitionRideUseCase } from './application/transition-ride.use-case';
import { acceptRideSchema } from './dto/accept-ride.dto';
import { listRidesSchema, type ListRidesDto } from './dto/list-rides.dto';
import { requestRideSchema, type RequestRideDto } from './dto/request-ride.dto';
import { transitionRideSchema, type TransitionRideDto } from './dto/transition-ride.dto';
import type { Principal } from './domain/ride-policy';
import { toResponse } from './infrastructure/rides.mapper';
import { zodToOpenApiComponent } from '../common/openapi/zod-to-openapi';
import {
  RideDetailResponseDto,
  RideListResponseDto,
  RideResponseDto,
} from '../common/openapi/api-schemas';
import { ApiAuthedErrorResponses } from '../common/openapi/api-error-responses';
import { RIDE_STATUSES } from './domain/ride-status';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../kernel/page-cursor';

/**
 * §4.4 — thin by construction: bind, call exactly one use-case, map to a status
 * code. No business rules, no repository access, no cache or socket calls. The
 * 41-of-the-product-doc anti-pattern (logic in the controller) is prevented by
 * there being nothing here to put it in.
 */
@ApiTags('rides')
@Controller('rides')
@UseGuards(JwtAuthGuard)
export class RidesController {
  constructor(
    private readonly requestRide: RequestRideUseCase,
    private readonly acceptRide: AcceptRideUseCase,
    private readonly transitionRide: TransitionRideUseCase,
    private readonly getRide: GetRideUseCase,
    private readonly listRides: ListRidesUseCase,
  ) {}

  @Post()
  @Roles('RIDER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    operationId: 'requestRide',
    summary: 'Request a ride',
    description: [
      'Creates a `REQUESTED` ride and returns it with `version: 1` and `driverId: null`.',
      '',
      'A rider may hold at most one active ride. Two concurrent requests cannot both succeed: the',
      'application checks first, and a partial unique index on `rides (riderId) WHERE status IN',
      '(REQUESTED, ACCEPTED, IN_PROGRESS)` settles the race in the database, so the loser gets',
      '`RIDER_ALREADY_HAS_ACTIVE_RIDE` rather than a second ride.',
      '',
      'The fare returned is an *estimate* computed at request time. There is no payment system, no',
      'charge and no capture (§9.1) — do not treat it as a chargeable amount.',
      '',
      'The state change is committed together with its `ride.requested` outbox row in one',
      'transaction, so the event cannot be lost by a crash between the two.',
    ].join('\n'),
  })
  @ApiBody({
    schema: zodToOpenApiComponent(requestRideSchema, 'RequestRideRequest'),
    examples: {
      default: {
        summary: 'Across the bay',
        value: {
          pickup: { lat: 37.7955, lng: -122.3937 },
          dropoff: { lat: 37.7749, lng: -122.4194 },
          pickupAddress: 'Ferry Building, San Francisco',
          dropoffAddress: '1 Market St, San Francisco',
        },
      },
    },
  })
  @ApiOkResponse({ type: RideResponseDto, description: 'The ride was created.' })
  @ApiAuthedErrorResponses('MISSING_FIELD', 'INVALID_COORDINATES', 'RIDER_ALREADY_HAS_ACTIVE_RIDE')
  async create(
    @CurrentUser() principal: Principal,
    @Body(new ZodValidationPipe(requestRideSchema)) dto: RequestRideDto,
    @CorrelationId() correlationId: string,
  ) {
    const { ride } = await this.requestRide.execute(principal, dto, correlationId);
    return toResponse(ride);
  }

  @Get('history')
  @ApiOperation({
    operationId: 'listRideHistory',
    summary: 'Ride history for the current principal',
    description: [
      'Newest first, scoped to the caller: a rider sees the rides they requested, a driver the rides',
      'they were assigned. Someone else’s ride is not in this list and is not distinguishable from',
      'a ride that does not exist.',
      '',
      'Paginated by keyset cursor, not offset: rides are ordered by `createdAt DESC`, and an offset',
      'would skip or repeat rows whenever a new ride is created mid-scroll. Follow `nextCursor` until',
      '`hasMore` is false.',
    ].join('\n'),
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: [
      'Filter by status. A comma-separated list is accepted, so',
      '`?status=REQUESTED,ACCEPTED,IN_PROGRESS` answers "what is my current ride?" in',
      'one request — which is the first question both home screens ask. An unknown',
      'value is a 400, not a silently empty result.',
    ].join('\n'),
    schema: { type: 'string', enum: [...RIDE_STATUSES] },
    example: 'REQUESTED,ACCEPTED,IN_PROGRESS',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque cursor from a previous response’s `nextCursor`.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Page size. Defaults to ${DEFAULT_PAGE_SIZE}, capped at ${MAX_PAGE_SIZE}.`,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
  })
  @ApiOkResponse({ type: RideListResponseDto })
  @ApiAuthedErrorResponses('MISSING_FIELD', 'INVALID_CURSOR')
  async history(
    @CurrentUser() principal: Principal,
    @Query(new ZodValidationPipe(listRidesSchema)) query: ListRidesDto,
  ) {
    const page = await this.listRides.history(principal, query);
    return { items: page.items.map(toResponse), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  @Get('available')
  @Roles('DRIVER')
  @ApiOperation({
    operationId: 'listAvailableRides',
    summary: 'Rides currently open for a driver to accept',
    description: [
      'Rides in `REQUESTED` with no driver attached, newest first.',
      '',
      'This is a flat, unpaged-by-distance listing. Nearest-driver matching is deliberately deferred',
      '(§9.1), so the list is not ordered by proximity and there is no fairness or batching rule —',
      'a ride is first-come-first-served through `PATCH /rides/{rideId}/accept`.',
    ].join('\n'),
  })
  @ApiQuery({ name: 'status', required: false, enum: RIDE_STATUSES, description: 'Usually left unset; defaults to `REQUESTED`.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque cursor from a previous response’s `nextCursor`.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Page size. Defaults to ${DEFAULT_PAGE_SIZE}, capped at ${MAX_PAGE_SIZE}.`,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
  })
  @ApiOkResponse({ type: RideListResponseDto })
  @ApiAuthedErrorResponses('MISSING_FIELD', 'INVALID_CURSOR', 'FORBIDDEN_ROLE')
  async available(
    @CurrentUser() principal: Principal,
    @Query(new ZodValidationPipe(listRidesSchema)) query: ListRidesDto,
  ) {
    const page = await this.listRides.availableToDriver(principal, query);
    return { items: page.items.map(toResponse), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  // Declared before `:rideId` so 'history' is never captured as an id.
  @Patch(':rideId/accept')
  @Roles('DRIVER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'acceptRide',
    summary: 'Atomically accept a ride',
    description: [
      'The write is a single conditional `UPDATE … WHERE status = REQUESTED AND driverId IS NULL AND',
      'version = <read>`, so two drivers racing cannot both win. Exactly one gets 200; every loser',
      'gets 409, and the failure is disambiguated *after* the write by re-reading the row.',
      '',
      '**Expect 409, and handle it as routine.** `RIDE_ALREADY_ACCEPTED` means another driver won —',
      'this is the normal outcome of a race, not an exceptional condition. `RIDE_NOT_ACCEPTABLE`',
      'means the ride is no longer `REQUESTED` (cancelled, or already finished).',
      '',
      'The body is empty and exists only to give the route a schema; send `{}`.',
    ].join('\n'),
  })
  @ApiParam({ name: 'rideId', format: 'uuid', description: 'The ride to accept.' })
  @ApiBody({ schema: zodToOpenApiComponent(acceptRideSchema, 'AcceptRideRequest'), required: false })
  @ApiOkResponse({ type: RideResponseDto, description: 'This driver now owns the ride.' })
  @ApiAuthedErrorResponses(
    'MISSING_FIELD',
    'RIDE_NOT_FOUND',
    'RIDE_ALREADY_ACCEPTED',
    'RIDE_NOT_ACCEPTABLE',
  )
  async accept(
    @CurrentUser() principal: Principal,
    @Param('rideId') rideId: string,
    @Body(new ZodValidationPipe(acceptRideSchema)) _dto: unknown,
    @CorrelationId() correlationId: string,
  ) {
    const ride = await this.acceptRide.execute(principal, rideId, correlationId);
    return toResponse(ride);
  }

  @Patch(':rideId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'transitionRide',
    summary: 'Transition a ride, guarded by the state machine',
    description: [
      'Moves the ride along the one legal path. Illegal transitions are rejected by the state',
      'machine, not by ad-hoc checks, and a transition is refused if the actor is not the party the',
      'transition requires.',
      '',
      'Legal moves: `REQUESTED → ACCEPTED` (accept only, via the accept route), `REQUESTED →',
      'CANCELLED` (rider), `ACCEPTED → IN_PROGRESS` (assigned driver), `ACCEPTED → CANCELLED`',
      '(assigned driver), `IN_PROGRESS → COMPLETED` (assigned driver), `IN_PROGRESS → CANCELLED`',
      '(assigned driver).',
      '',
      '**Cancellation is asymmetric, and deliberately so.** A rider may cancel only while',
      '`REQUESTED`; once a driver is committed, a rider may not unilaterally cancel, and gets',
      '`INVALID_TRANSITION` for `ACCEPTED → CANCELLED`. The assigned driver *may* cancel, because',
      'they are the only party who knows the trip is impossible — the vehicle has broken down, the',
      'rider is not at the pickup. A driver who is not the assigned one gets `RIDE_NOT_VISIBLE`',
      'rather than `FORBIDDEN`, since the offer reaches every available driver and answering 403',
      'would confirm the ride exists to somebody outside it.',
      '',
      'Cancelling keeps `driverId` on the ride and records `cancelledBy`, so the assignment remains',
      'a fact about the trip and the audit trail records who ended it.',
      '',
      '**Always send `version`.** It makes the write conditional on the state you saw. Omitting it',
      'is permitted for convenience but opts into last-writer-wins, where a stale tab silently',
      'overwrites a newer change; a mismatch returns `RIDE_VERSION_CONFLICT` and you should refetch.',
      '',
      'Identical to the `ride:transition` socket message, which calls this same use-case. There is',
      'exactly one way a ride state can change.',
    ].join('\n'),
  })
  @ApiParam({ name: 'rideId', format: 'uuid' })
  @ApiBody({
    schema: zodToOpenApiComponent(transitionRideSchema, 'TransitionRideRequest'),
    examples: {
      start: { summary: 'Driver starts the trip', value: { to: 'IN_PROGRESS', version: 2 } },
      complete: { summary: 'Driver completes the trip', value: { to: 'COMPLETED', version: 3 } },
      cancel: { summary: 'Rider cancels an unassigned request', value: { to: 'CANCELLED', version: 1, reason: 'Rider is no longer waiting' } },
      driverCancel: { summary: 'Assigned driver drops the trip', value: { to: 'CANCELLED', version: 2, reason: 'Vehicle broke down' } },
    },
  })
  @ApiOkResponse({ type: RideResponseDto, description: 'The ride, with its incremented version.' })
  @ApiAuthedErrorResponses(
    'MISSING_FIELD',
    'RIDE_NOT_FOUND',
    'RIDE_NOT_VISIBLE',
    'INVALID_TRANSITION',
    'WRONG_ACTOR_FOR_TRANSITION',
    'NOT_ASSIGNED_DRIVER',
    'RIDE_VERSION_CONFLICT',
  )
  async transition(
    @CurrentUser() principal: Principal,
    @Param('rideId') rideId: string,
    @Body(new ZodValidationPipe(transitionRideSchema)) dto: TransitionRideDto,
    @CorrelationId() correlationId: string,
  ) {
    const ride = await this.transitionRide.execute(principal, rideId, dto, correlationId);
    return toResponse(ride);
  }

  @Get(':rideId')
  @ApiOperation({
    operationId: 'getRide',
    summary: 'Ride detail with its event trail',
    description: [
      'Returns the ride plus its full `RideEvent` history, ordered by the gapless per-ride `seq`.',
      'This is the resync path: a client that detected a `seq` gap over the socket calls this to',
      'rebuild.',
      '',
      'Served from a Redis read-through cache for ~30 seconds, then invalidated after each write.',
      'The cache is never an authorization input — if Redis is down this endpoint still returns',
      'correct data from Postgres, just slower.',
      '',
      'A ride you are not party to returns **404** `RIDE_NOT_VISIBLE`, not 403, so this route is not',
      'an enumeration oracle.',
    ].join('\n'),
  })
  @ApiParam({ name: 'rideId', format: 'uuid' })
  @ApiOkResponse({ type: RideDetailResponseDto })
  @ApiAuthedErrorResponses('RIDE_NOT_FOUND', 'RIDE_NOT_VISIBLE')
  async detail(@CurrentUser() principal: Principal, @Param('rideId') rideId: string) {
    const { ride, events } = await this.getRide.execute(rideId, principal);
    return {
      ...toResponse(ride),
      events: events.map((e) => ({
        id: e.id, seq: e.seq, eventType: e.eventType, actorRole: e.actorRole, createdAt: e.createdAt.toISOString(),
      })),
    };
  }
}
