import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { TokenService } from '../token.service';
import type { Principal } from '../principal';
import { ACCESS_COOKIE } from '../../common/openapi/cookie-names';

/**
 * A narrow scan, not a full cookie parse: `decodeURIComponent` throws on a malformed
 * value, and a throw inside an extractor surfaces as a 500 instead of passport's 401.
 */
function cookieExtractor(name: string) {
  return (req: Request): string | null => {
    const header = req?.headers?.cookie;
    if (!header) return null;

    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== name) continue;

      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
    return null;
  };
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly tokens: TokenService,
  ) {
    super({
      // Cookie *and* bearer, header first: httpOnly is a browser's only path to the
      // cookie, and the header lets a seed script or test override a stale cookie.
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        cookieExtractor(ACCESS_COOKIE),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<AppConfig>(APP_CONFIG)!.JWT_SECRET,
      // Pinned: an unpinned verifier accepts algorithm confusion.
      algorithms: ['HS256'],
    });
  }

  validate(payload: { sub: string; role: 'RIDER' | 'DRIVER'; sid: string }): Principal {
    if (!payload?.sub) throw new UnauthorizedException();
    return { userId: payload.sub, role: payload.role, sessionId: payload.sid };
  }

  verifyFromString(token: string): Principal {
    const claims = this.tokens.verify(token);
    return this.validate(claims);
  }
}
