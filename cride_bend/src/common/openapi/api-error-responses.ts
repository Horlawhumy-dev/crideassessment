import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { ErrorEnvelopeDto } from './api-schemas';
import { ERROR_REGISTRY, type ErrorCode } from '../errors/error-codes';
import { ACCESS_SECURITY, BEARER_SECURITY, REFRESH_SECURITY } from './build-openapi-document';

/**
 * Statuses are read from ERROR_REGISTRY, the same map the exception filter reads, so a
 * documented status cannot disagree with a thrown one. Security scheme names are
 * imported because `ApiSecurity` matches by name, and a typo documents nothing.
 */

/** Standard failure responses. The route's own security is declared separately. */
export function ApiErrorResponses(...codes: ErrorCode[]) {
  const responses = codes.map((code) =>
    ApiResponse({
      status: ERROR_REGISTRY[code].status,
      description: `${ERROR_REGISTRY[code].category} — \`${code}\`: ${ERROR_REGISTRY[code].defaultMessage}`,
      type: ErrorEnvelopeDto,
    }),
  );

  return applyDecorators(ApiExtraModels(ErrorEnvelopeDto), ...responses);
}

/**
 * Both security schemes, because JwtAuthGuard accepts either: documenting only one
 * would tell browser clients to do something they cannot.
 */
export function ApiAuthedErrorResponses(...codes: ErrorCode[]) {
  return applyDecorators(
    ApiSecurity(ACCESS_SECURITY),
    ApiSecurity(BEARER_SECURITY),
    ApiErrorResponses(
      'MISSING_TOKEN',
      'TOKEN_EXPIRED',
      'FORBIDDEN_ROLE',
      'RATE_LIMITED',
      ...codes,
    ),
  );
}

/** Failure responses for a route whose credential is the refresh cookie. */
export function ApiRefreshCookieErrorResponses(...codes: ErrorCode[]) {
  return applyDecorators(
    ApiSecurity(REFRESH_SECURITY),
    ApiErrorResponses('INVALID_REFRESH_TOKEN', 'TOKEN_REVOKED', 'TOKEN_EXPIRED', ...codes),
  );
}

export { ACCESS_SECURITY, BEARER_SECURITY, REFRESH_SECURITY };
