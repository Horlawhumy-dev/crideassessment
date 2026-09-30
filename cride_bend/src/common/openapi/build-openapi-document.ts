import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import {
  ErrorEnvelopeDto,
  HealthResponseDto,
  PrincipalDto,
  SessionUserDto,
  RideDetailResponseDto,
  RideListResponseDto,
  RideResponseDto,
  AuthSessionResponseDto,
  AuthUserDto,
  MoneyDto,
  CoordinateDto,
  RideEventDto,
  ValidationIssueDto,
  ErrorResponseDto,
  ERROR_CODE_TABLE,
} from './api-schemas';
import { ERROR_REGISTRY, type ErrorCode } from '../errors/error-codes';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './cookie-names';
import { RIDE_STATUSES } from '../../rides/domain/ride-status';

export const ACCESS_SECURITY = 'accessCookie';
export const REFRESH_SECURITY = 'refreshCookie';
export const BEARER_SECURITY = 'bearerAuth';

/**
 * Everything here is derived from a source of truth (the error registry, the ride
 * status array, the Zod schemas) or declared next to the mapper it describes.
 */
export function buildOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('C-Ride API')
    .setDescription(
      [
        'Mini dispatch system — auth, rides, realtime, notifications.',
        '',
        '**Source of truth.** PostgreSQL holds every durable business decision. The',
        'WebSocket, FCM, Redis cache and Bull queues are delivery mechanisms: each can',
        'fail, be replaced or be rebuilt without losing a ride. Realtime is an',
        'accelerator, never an authority — a client that has been offline reaches a',
        'correct state over REST alone.',
        '',
        '**Auth.** Session endpoints set the httpOnly `cride.sid` (access) and',
        '`cride.refresh` (refresh) cookies. `POST /auth/register`, `POST /auth/login`',
        'and `POST /auth/refresh` are public; everything else requires a valid access',
        'token, supplied either as the cookie or as `Authorization: Bearer <token>`.',
        '',
        '**Errors.** Every failure is `{ error: { code, message, details?, correlationId, timestamp } }`.',
        'Switch on `code` — it is a stable enum — and never on `message`. See the',
        '`Error codes` page for the full table.',
        '',
        '**Money.** Amounts are `{ amountMinor: string, currency: string }`. `amountMinor`',
        'is a string by design: `3450` is $34.50, and a JSON number would invite float',
        'arithmetic somewhere downstream.',
        '',
        '**Concurrency.** `Ride.version` is an optimistic-concurrency token. Send it on',
        '`PATCH /rides/{rideId}/status` to make the write conditional; omit it and the',
        'route is last-writer-wins.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addTag('auth', 'Registration, login, token rotation, session introspection')
    .addTag('rides', 'The ride aggregate: request, accept, transition, read')
    .addTag('health', 'Liveness and dependency state. Unauthenticated and unthrottled.')
    .addServer('http://localhost:4000', 'Local (docker compose + npm run start:dev)')
    // The third argument is the *security scheme name*. `addCookieAuth` defaults it
    // to 'cookie', so two anonymous calls collapse into one entry and the survivor is
    // whichever was registered last.
    .addCookieAuth(
      ACCESS_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          'httpOnly access-token cookie, 15 minutes. Set by /auth/register, /auth/login and /auth/refresh. Preferred over the bearer header for browsers; required for the Socket.IO handshake, which can send a cookie but cannot read one.',
      },
      ACCESS_SECURITY,
    )
    .addCookieAuth(
      REFRESH_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          'httpOnly refresh-token cookie, 30 days, rotating. Never returned in a response body. Presenting an already-consumed token revokes the entire session family, which is how token theft is detected.',
      },
      REFRESH_SECURITY,
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Alternative to the cride.sid cookie, for non-browser clients. Short-lived: 15 minutes.',
      },
      BEARER_SECURITY,
    )
    .addGlobalParameters({
      name: 'x-request-id',
      in: 'header',
      required: false,
      description:
        'Correlation id. Send one to have it honoured end to end; otherwise the server generates it. Echoed on the response and present in every error body, log line and queued job.',
      schema: { type: 'string' },
    })
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    // Emitted even when only a schema registered here references them.
    extraModels: [
      RideResponseDto,
      RideDetailResponseDto,
      RideListResponseDto,
      RideEventDto,
      AuthSessionResponseDto,
      AuthUserDto,
      PrincipalDto,
      SessionUserDto,
      HealthResponseDto,
      MoneyDto,
      CoordinateDto,
      ErrorEnvelopeDto,
      ErrorResponseDto,
      ValidationIssueDto,
    ],
  });

  addErrorReferencePage(document);
  return document;
}

/**
 * Generated from ERROR_REGISTRY rather than typed out, so a code added to the backend
 * cannot be missing from the contract the frontend generates from.
 */
function addErrorReferencePage(document: OpenAPIObject): void {
  const byCategory = new Map<string, typeof ERROR_CODE_TABLE>();
  for (const entry of ERROR_CODE_TABLE) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  const tables = [...byCategory.entries()].map(([category, codes]) => {
    const rows = codes
      .map((c) => `| \`${c.code}\` | ${c.status} | ${c.defaultMessage} |`)
      .join('\n');
    return `**${category}**\n\n| Code | Status | Default message |\n| --- | --- | --- |\n${rows}`;
  });

  const description = [
    'Every error the API returns has the shape:',
    '',
    '```json',
    JSON.stringify(
      {
        error: {
          code: 'RIDE_ALREADY_ACCEPTED',
          message: ERROR_REGISTRY.RIDE_ALREADY_ACCEPTED.defaultMessage,
          details: { rideId: '5b1c…' },
          correlationId: '9f1c2b4e-0a1b-4c3d-8e5f-6a7b8c9d0e1f',
          timestamp: new Date(0).toISOString(),
        },
      },
      null,
      2,
    ),
    '```',
    '',
    '`code` is stable and safe to switch on. `message` is for humans and may be',
    'reworded. `details` is field-level context and never contains a stack trace or a',
    'raw database error.',
    '',
    ...tables,
    '',
    'Note `RIDE_NOT_VISIBLE` is a **404**, not a 403: a 403 confirms the ride exists,',
    'and confirming that to a user who cannot see it is an enumeration oracle.',
  ].join('\n');

  document.tags = [
    ...(Array.isArray(document.tags) ? document.tags : []),
    { name: 'errors', description },
  ];
}

export { RIDE_STATUSES };
export type { ErrorCode };
