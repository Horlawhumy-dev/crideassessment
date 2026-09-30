import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { zodToOpenApiComponent } from '../common/openapi/zod-to-openapi';
import { ApiAuthedErrorResponses } from '../common/openapi/api-error-responses';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import type { Principal } from '../rides/domain/ride-policy';
import { DEVICE_TOKEN_REPOSITORY, type DeviceTokenRepository } from './device-token.repository';

const registerDeviceSchema = z.object({
  // FCM registration tokens are long, opaque base64-ish strings.
  token: z.string().min(8).max(4096),
  platform: z.enum(['web', 'android', 'ios']).default('web'),
});

const revokeDeviceSchema = z.object({ token: z.string().min(8).max(4096) });

export type RegisterDeviceDto = z.infer<typeof registerDeviceSchema>;
export type RevokeDeviceDto = z.infer<typeof revokeDeviceSchema>;

/** Lets a client say "push can reach this device". `pushEnabled` reports whether the
 * deployment can actually deliver: registering against FCM_ENABLED=false succeeds and does
 * nothing, which is more honest than a toggle that silently never fires. */
@ApiTags('devices')
@Controller('devices')
export class DevicesController {
  constructor(
    @Inject(DEVICE_TOKEN_REPOSITORY) private readonly devices: DeviceTokenRepository,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'listMyDevices',
    summary: 'Devices this account can receive push on',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['items', 'pushEnabled'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['token', 'platform', 'createdAt'],
            properties: {
              token: { type: 'string' },
              platform: { type: 'string', enum: ['web', 'android', 'ios'] },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        pushEnabled: {
          type: 'boolean',
          description: 'False when this deployment has no FCM credentials configured.',
        },
      },
    },
  })
  @ApiAuthedErrorResponses()
  async list(@CurrentUser() principal: Principal) {
    return { items: await this.devices.listFor(principal.userId), pushEnabled: this.pushEnabled() };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'registerDevice',
    summary: 'Register this browser for ride push notifications',
    description: [
      'Idempotent: registering a token already known to this account refreshes it and clears any',
      'revoked marker. Registering a token that belonged to a *different* account reassigns it, which',
      'is the correct behaviour on a shared device and the reason a token is the unique key.',
    ].join('\n'),
  })
  @ApiBody({ schema: zodToOpenApiComponent(registerDeviceSchema, 'RegisterDeviceRequest') })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['token', 'platform', 'pushEnabled'],
      properties: {
        token: { type: 'string' },
        platform: { type: 'string' },
        pushEnabled: { type: 'boolean' },
      },
    },
  })
  @ApiAuthedErrorResponses('MISSING_FIELD')
  async register(
    @CurrentUser() principal: Principal,
    @Body(new ZodValidationPipe(registerDeviceSchema)) dto: RegisterDeviceDto,
  ) {
    await this.devices.register({
      userId: principal.userId,
      token: dto.token,
      platform: dto.platform,
    });
    return { token: dto.token, platform: dto.platform, pushEnabled: this.pushEnabled() };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'revokeDevice',
    summary: 'Stop sending push to one device',
    description: 'Marks the row revoked rather than deleting it, so a stale client cannot resurrect it.',
  })
  @ApiBody({ schema: zodToOpenApiComponent(revokeDeviceSchema, 'RevokeDeviceRequest') })
  @ApiAuthedErrorResponses('MISSING_FIELD')
  async revoke(
    @CurrentUser() principal: Principal,
    @Body(new ZodValidationPipe(revokeDeviceSchema)) dto: RevokeDeviceDto,
  ) {
    // Scoped to the caller: a token that is not theirs is a no-op rather than a 403,
    // so this route cannot be used to probe which tokens exist.
    const owned = (await this.devices.listFor(principal.userId)).some((d) => d.token === dto.token);
    if (owned) await this.devices.revoke(dto.token);
  }

  private pushEnabled(): boolean {
    return this.config.get<AppConfig>(APP_CONFIG)?.FCM_ENABLED ?? false;
  }
}
