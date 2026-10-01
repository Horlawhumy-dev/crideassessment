import { ConfigService } from '@nestjs/config';
import type { INestApplicationContext } from '@nestjs/common';

import { RedisIoAdapter } from './redis-io.adapter';
import type { AppConfig } from '../../config/configuration';

/** `app.enableCors()` cannot reach engine.io's polling handshake, and the omission is
 * invisible server-side: the socket connects and no `@SubscribeMessage` handler ever runs. */
describe('RedisIoAdapter', () => {
  const CORS_ORIGINS = ['http://localhost:3000', 'https://app.cride.ng'];

  /** The Redis half is stubbed: asserting on CORS must not require a live Redis. */
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

  /** Intercept what reaches `new Server(...)`: a real one would bind a port and leak. */
  function captureCorsOptions(origins: string[]): unknown {
    const adapter = adapterWith(origins);
    const seen: unknown[] = [];

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

    // The same origins the HTTP routes enforce, so a socket cannot be less restricted
    // than the REST API it shares a session cookie with.
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
