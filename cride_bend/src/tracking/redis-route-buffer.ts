import { Injectable } from '@nestjs/common';
import { RedisClient } from '../platform/cache/redis.client';
import { ROUTE_BUFFER, type RouteBuffer, type RoutePointSample } from './route-buffer.port';

/**
 * The cap is the point: without it an abandoned ride's list grows until the TTL fires.
 * With it memory is bounded and the oldest points go first — the least interesting end.
 */
const MAX_POINTS_PER_RIDE = 2_000;

/** Long enough that a Redis flush is the only realistic way to lose a live trail. */
const TTL_SECONDS = 6 * 60 * 60;

const KEY = (rideId: string) => `ride:track:${rideId}`;

interface SerialisedSample {
  lat: number;
  lng: number;
  speedKph: number | null;
  headingDeg: number | null;
  recordedAt: string;
}

@Injectable()
export class RedisRouteBuffer implements RouteBuffer {
  constructor(private readonly redis: RedisClient) {}

  async append(rideId: string, sample: RoutePointSample): Promise<void> {
    const key = KEY(rideId);
    const payload: SerialisedSample = {
      lat: sample.lat,
      lng: sample.lng,
      speedKph: sample.speedKph,
      headingDeg: sample.headingDeg,
      recordedAt: sample.recordedAt.toISOString(),
    };

    // RPUSH then LTRIM keeps the newest MAX points. Not pipelined: the commands are
    // independent, and an extra round trip per GPS frame is a poor trade on a bad connection.
    await this.redis.client.rpush(key, JSON.stringify(payload));
    await this.redis.client.ltrim(key, -MAX_POINTS_PER_RIDE, -1);
    await this.redis.client.expire(key, TTL_SECONDS);
  }

  /**
   * LRANGE + DEL in one MULTI. Overlapping drains (at-least-once delivery) would
   * otherwise read the same points, or delete points appended after the read.
   */
  async drain(rideId: string): Promise<readonly RoutePointSample[]> {
    const key = KEY(rideId);

    const results = await this.redis.client.multi().lrange(key, 0, -1).del(key).exec();

    // ioredis returns [err, value] tuples, and DEL replies null when the key is already gone.
    const raw = results?.[0]?.[1] as string[] | undefined;
    if (!Array.isArray(raw)) return [];

    const samples: RoutePointSample[] = [];
    for (const entry of raw) {
      try {
        samples.push(deserialise(JSON.parse(entry) as SerialisedSample));
      } catch {
        // Drop a malformed entry rather than failing the drain: the trail stays usable.
      }
    }
    return samples;
  }

  async size(rideId: string): Promise<number> {
    return this.redis.client.llen(KEY(rideId));
  }
}

const deserialise = (s: SerialisedSample): RoutePointSample => ({
  lat: s.lat,
  lng: s.lng,
  speedKph: s.speedKph ?? null,
  headingDeg: s.headingDeg ?? null,
  recordedAt: new Date(s.recordedAt),
});

export { ROUTE_BUFFER };