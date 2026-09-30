import { Inject, Injectable } from '@nestjs/common';
import { decodeCursor, type Page } from '../../kernel/page-cursor';
import { assertRole, type Principal } from '../domain/ride-policy';
import type { Ride } from '../domain/ride';
import { RIDE_REPOSITORY, type ListRidesFilter, type RideRepository } from './ports/ride.repository';
import type { ListRidesDto } from '../dto/list-rides.dto';

@Injectable()
export class ListRidesUseCase {
  constructor(@Inject(RIDE_REPOSITORY) private readonly rides: RideRepository) {}

  /** Ride history. Keyset-paginated, because it grows forever (§kernel/page-cursor). */
  async history(principal: Principal, dto: ListRidesDto): Promise<Page<Ride>> {
    const filter: ListRidesFilter = {
      riderId: principal.role === 'RIDER' ? principal.userId : undefined,
      driverId: principal.role === 'DRIVER' ? principal.userId : undefined,
      // `statuses`, not `status`: `?status=REQUESTED,ACCEPTED,IN_PROGRESS` is the
      // "what is my current ride?" query that both home screens open with, and
      // the repository already has the `in` clause and the index for it.
      ...(dto.status ? { statuses: dto.status } : {}),
      cursor: dto.cursor ? decodeCursor(dto.cursor) ?? undefined : undefined,
      limit: dto.limit,
    };
    return this.rides.findMany(filter);
  }

  /**
   * §4.9 / driver offers. A driver browsing pending rides is not a participant in
   * any of them, so assertCanView is deliberately NOT applied here — availability
   * is a separate, role-scoped query, not a leak of a specific ride's detail.
   */
  async availableToDriver(principal: Principal, dto: ListRidesDto): Promise<Page<Ride>> {
    assertRole(principal, 'DRIVER');
    return this.rides.findMany({
      status: 'REQUESTED',
      cursor: dto.cursor ? decodeCursor(dto.cursor) ?? undefined : undefined,
      limit: dto.limit,
    });
  }
}
