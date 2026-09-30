import { Body, Controller, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CorrelationId } from '../common/decorators/correlation-id.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { zodToOpenApiComponent } from '../common/openapi/zod-to-openapi';
import { ApiAuthedErrorResponses } from '../common/openapi/api-error-responses';
import type { Principal } from '../rides/domain/ride-policy';
import { DriverAvailabilityService } from './driver-availability.service';
import { setAvailabilitySchema, type SetAvailabilityDto } from './dto/set-availability.dto';

/**
 * A separate module rather than two more routes on RidesController: availability is a
 * fact about a person, not a ride.
 */
@ApiTags('driver')
@Controller('driver')
export class DriverController {
  constructor(private readonly availability: DriverAvailabilityService) {}

  @Get('availability')
  @ApiOperation({
    operationId: 'getDriverAvailability',
    summary: 'Whether this driver is advertising for rides',
    description: [
      'The durable value behind the driver toggle. Read it on load so the switch reflects reality',
      'after a reload rather than defaulting to whatever the component was initialised with.',
      '',
      'Availability also governs `ride:offer` delivery: a driver who is unavailable is not in the',
      '`drivers:available` room, so they are not sent offers at all.',
    ].join('\n'),
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['driverId', 'isAvailable'],
      properties: {
        driverId: { type: 'string', format: 'uuid' },
        isAvailable: { type: 'boolean' },
      },
    },
  })
  @ApiAuthedErrorResponses('FORBIDDEN_ROLE', 'USER_NOT_FOUND')
  get(@CurrentUser() principal: Principal) {
    return this.availability.get(principal);
  }

  @Patch('availability')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'setDriverAvailability',
    summary: 'Start or stop advertising for rides',
    description: [
      'Persists the flag. The caller should also emit `driver:availability` on the socket so the',
      'server can move this driver in or out of the `drivers:available` room immediately — the',
      'persisted value is what survives a reload, the socket message is what takes effect now.',
    ].join('\n'),
  })
  @ApiBody({ schema: zodToOpenApiComponent(setAvailabilitySchema, 'SetAvailabilityRequest') })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['driverId', 'isAvailable'],
      properties: {
        driverId: { type: 'string', format: 'uuid' },
        isAvailable: { type: 'boolean' },
      },
    },
  })
  @ApiAuthedErrorResponses('MISSING_FIELD', 'FORBIDDEN_ROLE', 'USER_NOT_FOUND')
  async set(
    @CurrentUser() principal: Principal,
    @Body(new ZodValidationPipe(setAvailabilitySchema)) dto: SetAvailabilityDto,
    @CorrelationId() correlationId: string,
  ) {
    return this.availability.set(principal, dto.isAvailable);
  }
}
