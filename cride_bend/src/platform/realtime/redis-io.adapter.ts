import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { ConfigService } from '@nestjs/config';
import type { INestApplicationContext } from '@nestjs/common';
import type { ServerOptions } from 'socket.io';
import type { CorsOptions } from 'cors';
import { RedisClient } from '../cache/redis.client';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';

/** socket.io 4.8: `Namespace.adapter` is a property, so the adapter is swapped with
 * `Server#adapter(fn)` before the server starts serving. Without it rooms are per-replica
 * and a driver on replica B gets nothing when the relay publishes from replica A. */
export class RedisIoAdapter extends IoAdapter {
  constructor(
    private readonly app: INestApplicationContext,
    private readonly redis: RedisClient,
  ) {
    super(app);
  }

  /** engine.io serves `/socket.io` itself, so `app.enableCors()` never reaches the polling
   * handshake — and `transports: ['websocket']` is not an escape: the socket connects and no
   * `@SubscribeMessage` handler ever runs. A gateway's `cors` covers the namespace, not
   * long-polling; only the root `Server` options do. */
  private corsOptions(): CorsOptions {
    const config = this.app.get(ConfigService).get<AppConfig>(APP_CONFIG)!;
    return {
      origin: config.corsOrigins,
      // Required for the httpOnly session cookie to ride along on the handshake.
      credentials: true,
      exposedHeaders: ['x-request-id'],
    };
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, {
      ...options,
      cors: this.corsOptions(),
    }) as {
      adapter: (fn: unknown) => unknown;
    };

    // A subscribed ioredis client cannot issue commands, so these are separate from
    // `this.redis.client`. `duplicateForPubSub`, not `duplicate`: the adapter psubscribes
    // while the server is being constructed, before the handshake completes, and
    // `enableOfflineQueue: false` would reject that and crash the process at boot.
    const pubClient = this.redis.duplicateForPubSub();
    const subClient = this.redis.duplicateForPubSub();

    server.adapter(createAdapter(pubClient, subClient));
    return server;
  }
}
