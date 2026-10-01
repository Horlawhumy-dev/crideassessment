import { Inject, Injectable } from '@nestjs/common';
import { decodeCursor, type Page, type PageCursor } from '../../kernel/page-cursor';
import { InvalidCursorError } from '../../common/errors/domain-error';
import { assertRole, type Principal } from '../domain/ride-policy';
import type { Ride } from '../domain/ride';
import { RIDE_REPOSITORY, type ListRidesFilter, type RideRepository } from './ports/ride.repository';
import type { ListRidesDto } from '../dto/list-rides.dto';

/** A cursor the caller sent but that does not decode is an error, not an absent cursor:
 *  coercing it to `undefined` silently restarts at page 1, so a client paging a history loops
 *  on the first page for ever. `INVALID_CURSOR` is registered but nothing threw it. */
function requireCursor(raw: string | undefined): PageCursor | undefined {
  if (!raw) return undefined;
  const cursor = decodeCursor(raw);
  if (!cursor) throw new InvalidCursorError();
  return cursor;
}

@Injectable()
export class ListRidesUseCase {
  constructor(@Inject(RIDE_REPOSITORY) private readonly rides: RideRepository) {}

  /** Ride history; keyset-paginated because this query grows forever. */
  async history(principal: Principal, dto: ListRidesDto): Promise<Page<Ride>> {
    const filter: ListRidesFilter = {
      riderId: principal.role === 'RIDER' ? principal.userId : undefined,
      driverId: principal.role === 'DRIVER' ? principal.userId : undefined,
      // Plural `statuses`: `?status=REQUESTED,ACCEPTED,IN_PROGRESS` is the "what is my
      // current ride?" query both home screens open with.
      ...(dto.status ? { statuses: dto.status } : {}),
      cursor: requireCursor(dto.cursor),
      limit: dto.limit,
    };
    return this.rides.findMany(filter);
  }

  /** Driver offers. `assertCanView` is deliberately NOT applied: a driver browsing pending
   *  rides is a participant in none of them, and availability is a role-scoped query. */
  async availableToDriver(principal: Principal, dto: ListRidesDto): Promise<Page<Ride>> {
    assertRole(principal, 'DRIVER');
    return this.rides.findMany({
      status: 'REQUESTED',
      cursor: requireCursor(dto.cursor),
      limit: dto.limit,
    });
  }
}
