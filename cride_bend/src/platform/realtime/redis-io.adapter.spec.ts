import { ConfigService } from '@nestjs/config';
import type { INestApplicationContext } from '@nestjs/common';

import { RedisIoAdapter } from './redis-io.adapter';
import type { AppConfig } from '../../config/configuration';

/**
 * engine.io's polling handshake needs CORS that `app.enableCors()` cannot supply, and the
 * omission is invisible from the server side: `/health` was 200, sockets that reached it
 * connected, and only the browser failed. `transports: ['websocket']` is not an escape —
 * the socket connects and no `@SubscribeMessage` handler ever runs.
 */
describe('RedisIoAdapter', () => {
  const CORS_ORIGINS = ['http://localhost:3000', 'https://app.cride.ng'];

  /** The Redis half is stubbed: `createIOServer` goes on to build the pub/sub adapter,
   * and asserting on CORS must not require a live Redis. */
  function adapterWith(origins: string[]): RedisIoAdapter {
    const app = {
      get: (token: unknown) =>
        token === ConfigService
          ? { get: () => ({ corsOrigins: origins } as AppConfig) }
          : undefined,
    } as unknown as INestApplicationContext;

    const redis = { duplicateForPubSub: () => ({ on: () => undefined }) } as never;
    return new RedisIoAdapter(app, redis);
  }

  /** Intercept what reaches `new Server(...)`: constructing a real one would bind a port
   * and leave a handle open. */
  function captureCorsOptions(origins: string[]): unknown {
    const adapter = adapterWith(origins);
    const seen: unknown[] = [];

    // Spy on the base implementation, the only thing that touches the options
    // before handing them to socket.io.
    const base = Object.getPrototypeOf(RedisIoAdapter.prototype) as {
      createIOServer: (port: number, options?: unknown) => unknown;
    };
    const original = base.createIOServer;
    base.createIOServer = (_port: number, options?: unknown) => {
      seen.push(options);
      return { adapter: () => undefined };
    };

    try {
      adapter.createIOServer(0, { path: '/socket.io' } as never);
      base.createIOServer = original;
    } catch {
      base.createIOServer = original;
      throw new Error('adapter threw before reaching the base implementation');
    }

    expect(seen).toHaveLength(1);
    return (seen[0] as { cors: unknown }).cors;
  }

  it('gives engine.io the configured origins, so the polling handshake is allowed', () => {
    const cors = captureCorsOptions(CORS_ORIGINS) as { origin: string[] };

    // Not a wildcard, and not a hardcoded localhost: the same origins the HTTP routes
    // enforce, so a socket cannot be less restricted than the REST API that shares
    // its session cookie.
    expect(cors.origin).toEqual(CORS_ORIGINS);
  });

  it('allows credentials, because the session rides on the handshake as a cookie', () => {
    const cors = captureCorsOptions(CORS_ORIGINS) as { credentials: boolean };

    // Without this the `cride.sid` cookie is not sent and every connection is rejected
    // in `handleConnection` — a failure that looks like a bad token.
    expect(cors.credentials).toBe(true);
  });

  it('exposes x-request-id, so a socket frame can be correlated with its HTTP route', () => {
    const cors = captureCorsOptions(CORS_ORIGINS) as { exposedHeaders: string[] };

    expect(cors.exposedHeaders).toContain('x-request-id');
  });

  it('preserves the options Nest passed in, rather than replacing them', () => {
    const adapter = adapterWith(CORS_ORIGINS);
    const seen: unknown[] = [];
    const base = Object.getPrototypeOf(RedisIoAdapter.prototype) as {
      createIOServer: (port: number, options?: unknown) => unknown;
    };
    const original = base.createIOServer;
    base.createIOServer = (_p: number, options?: unknown) => {
      seen.push(options);
      return { adapter: () => undefined };
    };
    try {
      adapter.createIOServer(0, { path: '/socket.io', pingTimeout: 25_000 } as never);
    } finally {
      base.createIOServer = original;
    }

    // A spread that dropped the incoming options would silently reset the transport
    // path and every socket.io default, and nothing would fail loudly.
    expect(seen[0]).toMatchObject({ path: '/socket.io', pingTimeout: 25_000 });
  });
});
