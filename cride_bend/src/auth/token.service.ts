import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { AuthError } from '../common/errors/domain-error';
import type { AccessTokenClaims } from './principal';

/**
 * The one access-token verifier, shared by the HTTP strategy and the Socket.IO
 * handshake: two verifiers drift, and a drifting verifier is an authentication bypass.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  signAccessToken(claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'>): {
    token: string;
    claims: AccessTokenClaims;
  } {
    const full: AccessTokenClaims = {
      ...claims,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + this.accessTtlSeconds(),
      jti: randomUUID(),
    };
    return { token: this.jwt.sign(full), claims: full };
  }

  verify(token: string): AccessTokenClaims {
    try {
      // Pinned explicitly: never trust the header's alg, and never accept `none`.
      return this.jwt.verify<AccessTokenClaims>(token, {
        algorithms: ['HS256'],
        secret: this.config.get<AppConfig>(APP_CONFIG)!.JWT_SECRET,
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TokenExpiredError') throw new AuthError('TOKEN_EXPIRED');
      throw new AuthError('TOKEN_REVOKED');
    }
  }

  private accessTtlSeconds(): number {
    const raw = this.config.get<AppConfig>(APP_CONFIG)!.JWT_EXPIRES_IN;
    const match = /^(\d+)([smhd])$/.exec(raw);
    if (!match) return 900;
    const n = Number(match[1]);
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
    return n * unit;
  }
}
