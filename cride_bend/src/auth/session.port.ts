import { createHash, randomBytes } from 'node:crypto';

export const SESSION_STORE = Symbol('SESSION_STORE');

/**
 * Refresh tokens are opaque random bytes stored only as a SHA-256 hash, grouped into a
 * family. Presenting an already-used token means two parties hold it, so the family is
 * revoked: the thief and the victim are logged out together.
 */
export interface SessionStore {
  issue(input: {
    userId: string;
    familyId: string;
    token: string;
    expiresAt: Date;
  }): Promise<void>;

  /** null covers unknown, revoked and expired alike; only 'REPLAYED' burns the family. */
  consume(token: string): Promise<{ userId: string; familyId: string } | 'REPLAYED' | null>;

  revokeFamily(familyId: string): Promise<void>;
  revokeSessionUserTokens(userId: string): Promise<void>;
}

export const REFRESH_TOKEN_TTL_DAYS = 30;

/** SHA-256 rather than a JWT: a DB read must yield no usable credential. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function newFamilyId(): string {
  return randomBytes(16).toString('hex');
}
