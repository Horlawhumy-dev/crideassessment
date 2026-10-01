import type { Socket } from 'socket.io';
import { Injectable } from '@nestjs/common';
import { TokenService } from './token.service';
import type { Principal } from './principal';

/**
 * A socket client can send a cookie but cannot read localStorage, so this handshake
 * works only because the access token is also the httpOnly `cride.sid` cookie.
 */
@Injectable()
export class SocketAuth {
  constructor(private readonly tokens: TokenService) {}

  authenticate(socket: Socket): Principal {
    const header = socket.handshake.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const fromAuth = bearer ?? socket.handshake.auth?.token;
    const fromCookie = parseCookie(socket.handshake.headers.cookie)['cride.sid'];

    const claims = this.tokens.verify(fromAuth ?? fromCookie ?? '');
    return { userId: claims.sub, role: claims.role, sessionId: claims.sid };
  }
}

function parseCookie(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      return idx === -1
        ? [part.trim(), '']
        : [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1))];
    }),
  );
}
