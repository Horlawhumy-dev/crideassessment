import { Injectable, Logger } from '@nestjs/common';
import { RedisClient } from '../platform/cache/redis.client';
import { LOCATION_STORE, type DriverLocation, type LocationStore } from './location.store';

const CHANNEL = (rideId: string) => `ride:loc:${rideId}`;

@Injectable()
export class RedisLocationStore implements LocationStore {
  private readonly logger = new Logger(RedisLocationStore.name);
  private handlers = new Set<(rideId: string, loc: DriverLocation) => void>();
  private wired = false;

  constructor(private readonly redis: RedisClient) {}

  private ensureSubscriber(): void {
    if (this.wired) return;
    this.wired = true;
    // A dedicated connection: a subscribed ioredis client cannot issue commands.
    // duplicateForPubSub because psubscribe runs before the handshake completes, and
    // the shared client's `enableOfflineQueue: false` would reject it.
    const sub = this.redis.duplicateForPubSub();
    sub.psubscribe('ride:loc:*', (err) => {
      if (err) this.logger.warn('location.subscribe_failed', { err: err.message });
    });
    sub.on('pmessage', (_pattern, channel, message) => {
      const rideId = channel.replace('ride:loc:', '');
      try {
        const loc = JSON.parse(message) as SerialisedLocation;
        this.handlers.forEach((h) => h(rideId, deserialise(loc)));
      } catch {
        /* a malformed frame must not kill the subscriber */
      }
    });
  }

  async put(rideId: string, location: DriverLocation, ttlSeconds: number): Promise<void> {
    // speedKph and accuracyM are persisted, not just published: the stored value is what
    // the next frame's checks read, so a null is written as an empty string.
    await this.redis.client.hset(`ride:loc:${rideId}`, {
      driverId: location.driverId,
      lat: String(location.position.lat),
      lng: String(location.position.lng),
      heading: location.heading === null ? '' : String(location.heading),
      speedKph: location.speedKph === null ? '' : String(location.speedKph),
      accuracyM: location.accuracyM === null ? '' : String(location.accuracyM),
      recordedAt: location.recordedAt.toISOString(),
    });
    await this.redis.client.expire(`ride:loc:${rideId}`, ttlSeconds);
  }

  async get(rideId: string): Promise<DriverLocation | null> {
    const raw = await this.redis.client.hgetall(`ride:loc:${rideId}`);

    // A hash missing fields is partially written (a crash between HSET and EXPIRE).
    // Treating it as absent is correct: the caller's fallback is "no previous position",
    // which skips teleport detection for a frame rather than rejecting on corrupt data.
    const driverId = raw['driverId'];
    const lat = raw['lat'];
    const lng = raw['lng'];
    const recordedAt = raw['recordedAt'];
    if (!driverId || lat === undefined || lng === undefined || recordedAt === undefined) {
      return null;
    }

    const speedKph = raw['speedKph'];
    const accuracyM = raw['accuracyM'];
    const heading = raw['heading'];

    return {
      driverId,
      position: { lat: Number(lat), lng: Number(lng) },
      heading: heading ? Number(heading) : null,
      speedKph: speedKph ? Number(speedKph) : null,
      accuracyM: accuracyM ? Number(accuracyM) : null,
      recordedAt: new Date(recordedAt),
    };
  }

/**
 * Direct pub/sub, not the outbox: a GPS ping is worthless after 60 s, so a Postgres write
 * and the relay latency it adds would deliver already-stale data.
 */
  async publish(rideId: string, location: DriverLocation): Promise<void> {
    await this.redis.client.publish(CHANNEL(rideId), JSON.stringify(serialise(location)));
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    // SET key 1 PX ttl NX: atomic in one round trip, so two concurrent frames from the
    // same driver cannot both observe success.
    const res = await this.redis.client.set(`loc:rate:${key}`, '1', 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  subscribe(handler: (rideId: string, loc: DriverLocation) => void): () => void {
    this.ensureSubscriber();
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

interface SerialisedLocation {
  driverId: string;
  lat: number;
  lng: number;
  heading: number | null;
  speedKph: number | null;
  accuracyM: number | null;
  recordedAt: string;
}

const serialise = (l: DriverLocation): SerialisedLocation => ({
  driverId: l.driverId,
  lat: l.position.lat,
  lng: l.position.lng,
  heading: l.heading,
  speedKph: l.speedKph,
  accuracyM: l.accuracyM,
  recordedAt: l.recordedAt.toISOString(),
});

const deserialise = (l: SerialisedLocation): DriverLocation => ({
  driverId: l.driverId,
  position: { lat: l.lat, lng: l.lng },
  heading: l.heading,
  speedKph: l.speedKph,
  accuracyM: l.accuracyM,
  recordedAt: new Date(l.recordedAt),
});

export { LOCATION_STORE };
