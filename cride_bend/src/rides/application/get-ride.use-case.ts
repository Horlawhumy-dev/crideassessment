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

/**
 * §4.10.2 read-through.
 *
 * Note step 1 precedes step 2. Authorizing *after* a cache hit would make the
 * cache an authorization decision, which is P1 and P3 violated: a cached object
 * scoped for one viewer could be served to another.
 */
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
      // Post-read, so a cache hit never bypasses the ownership check above.
      // No explicit TTL: the adapter owns `RIDE_CACHE_TTL_SECONDS`. A literal 30
      // here meant the documented config knob silently did nothing.
      await this.cache.set(ride).catch(() => undefined);
    }

    assertCanView(ride, principal);

    const events = await this.rides.listEvents(rideId);
    return { ride, events };
  }

  /**
   * §4.8.3 — events after a sequence, for socket resync.
   *
   * Takes an already-authorised Ride rather than a principal, so a caller cannot
   * reach an event stream without having passed assertCanView for that ride.
   */
  async eventsAfter(ride: Ride, lastSeq: number): Promise<RideEvent[]> {
    return this.rides.listEvents(ride.id, lastSeq);
  }
}
