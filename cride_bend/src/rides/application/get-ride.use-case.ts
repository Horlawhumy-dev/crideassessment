import { Inject, Injectable } from '@nestjs/common';
import { RideNotFoundError } from '../../common/errors/domain-error';
import { MetricsService } from '../../platform/otel/metrics';
import { assertCanView, type Principal } from '../domain/ride-policy';
import type { Ride, RideEvent } from '../domain/ride';
import { RIDE_REPOSITORY, type RideRepository } from './ports/ride.repository';
import { RIDE_CACHE_PORT, type RideCachePort } from './ports/ride-cache.port';

export interface RideDetail {
  readonly ride: Ride;
  readonly events: readonly RideEvent[];
}

/** Read-through. Authorization runs *after* the cache read but the cache is never an
 *  authorization input: a cached object scoped for one viewer must not be served to another. */
@Injectable()
export class GetRideUseCase {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly rides: RideRepository,
    @Inject(RIDE_CACHE_PORT) private readonly cache: RideCachePort,
    private readonly metrics: MetricsService,
  ) {}

  async execute(rideId: string, principal: Principal): Promise<RideDetail> {
    let ride = await this.cache.get(rideId);

    if (ride) {
      this.metrics.counter('ride_cache_total').inc({ result: 'hit' });
    } else {
      this.metrics.counter('ride_cache_total').inc({ result: 'miss' });
      ride = await this.rides.findById(rideId);
      if (!ride) throw new RideNotFoundError(rideId);
      // Populate after the ownership check, so a hit never bypasses it. No literal
      // TTL: the adapter owns RIDE_CACHE_TTL_SECONDS.
      await this.cache.set(ride).catch(() => undefined);
    }

    assertCanView(ride, principal);

    const events = await this.rides.listEvents(rideId);
    return { ride, events };
  }

  /** Takes an already-authorised `Ride`, not a principal, so a caller cannot reach an
   *  event stream without having passed `assertCanView` for that ride. */
  async eventsAfter(ride: Ride, lastSeq: number): Promise<RideEvent[]> {
    return this.rides.listEvents(ride.id, lastSeq);
  }
}
