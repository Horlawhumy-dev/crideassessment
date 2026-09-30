import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisClient } from '../cache/redis.client';
import { EVENT_BUS, type EventBus } from './event-bus.port';

/**
 * Pub/sub rather than a list or a stream: these are live state notifications whose
 * authoritative copy is PostgreSQL, so a subscriber that missed one resyncs from the `seq`
 * gap check rather than replaying a backlog nobody asked for.
 *
 * The subscriber connection is separate from the command client because a subscribed
 * ioredis connection cannot issue commands, and that client also serves the ride cache and
 * the location rate limiter.
 */
@Injectable()
export class RedisEventBus implements EventBus, OnApplicationShutdown {
  private readonly logger = new Logger(RedisEventBus.name);
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  private subscriber: Redis | null = null;
  private subscribing: Promise<void> | null = null;

  constructor(private readonly redis: RedisClient) {}

  async publish(topic: string, payload: unknown): Promise<void> {
    await this.redis.client.publish(topic, JSON.stringify(payload));
  }

  subscribe(topic: string, handler: (payload: unknown) => void): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler);
    this.handlers.set(topic, set);

    // Re-issuing SUBSCRIBE for an already-subscribed channel is a no-op in Redis,
    // so this is safe on every new topic and needs no tracking of covered channels.
    void this.ensureSubscribed();

    return () => {
      set.delete(handler);
    };
  }

  private ensureSubscribed(): Promise<void> {
    if (this.subscribing) return this.subscribing;

    this.subscribing = (async () => {
      // duplicateForPubSub: this subscribe is issued while the connection is still
      // handshaking, and `enableOfflineQueue: false` would reject it. See
      // RedisClient#duplicateForPubSub.
      const sub = this.redis.duplicateForPubSub();
      this.subscriber = sub;

      sub.on('error', (err: Error) =>
        this.logger.warn('event_bus.subscriber_error', { err: err.message }),
      );
      sub.on('message', (channel: string, message: string) => {
        const set = this.handlers.get(channel);
        if (!set) return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }

        for (const handler of set) {
          try {
            handler(parsed);
          } catch (err) {
            // One faulty handler must not stop delivery to the others — a throwing
            // subscriber would otherwise silently drop every later event.
            this.logger.error('event_bus.handler_failed', { channel, err: String(err) });
          }
        }
      });

      await sub.subscribe(...this.handlers.keys());
    })().catch((err: unknown) => {
      // Allow a later call to retry rather than leaving the bus permanently dead.
      this.subscribing = null;
      this.logger.error('event_bus.subscribe_failed', { err: String(err) });
    });

    return this.subscribing;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.subscribing?.catch(() => undefined);
    if (!this.subscriber) return;
    await this.subscriber.quit().catch(() => this.subscriber?.disconnect());
    this.subscriber = null;
    this.subscribing = null;
  }
}

export { EVENT_BUS };
