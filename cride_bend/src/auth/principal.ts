export type { Principal } from '../rides/domain/ride-policy';

export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresInSeconds: number;
}

/** Claims are minimal by design: a JWT payload is base64, not encrypted, so no PII. */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly role: 'RIDER' | 'DRIVER';
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}
