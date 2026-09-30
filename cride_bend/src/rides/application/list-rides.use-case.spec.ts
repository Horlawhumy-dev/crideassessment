import { ListRidesUseCase } from './list-rides.use-case';
import type { ListRidesFilter, RideRepository } from './ports/ride.repository';
import type { Principal } from '../../auth/principal';
import type { ListRidesDto } from '../dto/list-rides.dto';
import { encodeCursor } from '../../kernel/page-cursor';

/**
 * §4.6 / §5.4 — the "what is my current ride?" query, tested.
 *
 * Both home screens open with the same question, and both answer it with
 * `GET /rides/history?status=REQUESTED,ACCEPTED,IN_PROGRESS`. That is a
 * comma-separated list, which the DTO parses into an array and the repository
 * turns into a single `in` clause. Three things about it are easy to get wrong
 * and none of them throw:
 *
 *   1. Spreading the array wrongly, so the filter silently narrows to one status
 *      and a rider whose driver has accepted sees "no active ride".
 *   2. Dropping the rider/driver scope when a status filter is present — which
 *      would turn ride history into every ride on the platform.
 *   3. Passing `statuses` where the repository reads `status`, or the reverse,
 *      because both exist on the port and only one of them is plural.
 *
 * So the assertions below are on the filter object handed to the repository,
 * which is the only place any of that can be observed.
 */

const RIDER: Principal = { userId: 'rider-1', role: 'RIDER', sessionId: 'sess-1' };
const DRIVER: Principal = { userId: 'driver-1', role: 'DRIVER', sessionId: 'sess-2' };

function emptyPage() {
  return { items: [], nextCursor: null, hasMore: false };
}

interface Stub {
  useCase: ListRidesUseCase;
  /**
   * The one filter the repository was asked for.
   *
   * Asserting the call count is part of the point: a use case that called
   * `findMany` twice would be doing a second query nobody asked for, and reading
   * `only()` would quietly hide that.
   */
  only: () => ListRidesFilter;
}

function stub(): Stub {
  const calls: ListRidesFilter[] = [];
  const repository = {
    findMany: (filter: ListRidesFilter) => {
      calls.push(filter);
      return Promise.resolve(emptyPage());
    },
  } as unknown as RideRepository;

  return {
    useCase: new ListRidesUseCase(repository),
    only: () => {
      expect(calls).toHaveLength(1);
      return calls[0]!;
    },
  };
}

function dto(overrides: Partial<ListRidesDto> = {}): ListRidesDto {
  return { limit: 20, ...overrides } as ListRidesDto;
}

describe('ListRidesUseCase.history', () => {
  describe('the comma-separated status filter', () => {
    it('passes all three live statuses through as a list', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto({ status: ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS'] }));

      // Every one of them, in order. An implementation that sent only the first
      // would still compile and would still return 200 — it would just tell a
      // rider with an accepted ride that they have no active ride.
      expect(only().statuses).toEqual(['REQUESTED', 'ACCEPTED', 'IN_PROGRESS']);
    });

    it('never sets the singular `status` alongside the list', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto({ status: ['ACCEPTED', 'IN_PROGRESS'] }));

      // Both fields exist on the port and both are valid filters. A use case
      // that set both leaves the repository's precedence as an unstated
      // assumption, and the answer would differ between the fake and Postgres.
      expect(only().status).toBeUndefined();
    });

    it('omits `statuses` entirely when no filter was requested', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto());

      // Not `statuses: []`. An empty array and an absent key are different
      // queries: an empty `in ()` matches nothing.
      expect('statuses' in only()).toBe(false);
    });

    it('omits `statuses` when the DTO parses an empty value to undefined', async () => {
      const { useCase, only } = stub();

      // `?status=` with nothing after it. The DTO turns that into `undefined`,
      // and the spread guard has to keep it out of the filter entirely.
      await useCase.history(RIDER, dto({ status: undefined }));

      expect('statuses' in only()).toBe(false);
    });
  });

  describe('scoping', () => {
    it('scopes a rider to their own rides, alongside the status filter', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto({ status: ['ACCEPTED'] }));

      // The dangerous regression: a status filter that quietly replaced the
      // rider scope would list other people's accepted rides.
      expect(only().riderId).toBe('rider-1');
      expect(only().driverId).toBeUndefined();
    });

    it('scopes a driver to rides they hold, and does not pass their own id as a rider', async () => {
      const { useCase, only } = stub();

      await useCase.history(DRIVER, dto({ status: ['ACCEPTED', 'IN_PROGRESS'] }));

      expect(only().driverId).toBe('driver-1');
      expect(only().riderId).toBeUndefined();
    });
  });

  describe('pagination', () => {
    it('decodes the cursor rather than forwarding the opaque string', async () => {
      const { useCase, only } = stub();
      const cursor = encodeCursor({ createdAt: '2026-09-30T10:00:00.000Z', id: 'ride-9' });

      await useCase.history(RIDER, dto({ cursor, status: ['REQUESTED'] }));

      // The cursor is a repository concept. Handing the use case's string to the
      // repository as if it were one would move the keyset boundary into two
      // places that could disagree.
      expect(only().cursor).toEqual({ createdAt: '2026-09-30T10:00:00.000Z', id: 'ride-9' });
    });

    it('leaves the cursor undefined for a malformed value instead of throwing', async () => {
      const { useCase, only } = stub();

      // A hand-edited or stale cursor must not 500. §kernel/page-cursor decodes
      // defensively, and the first page is the right answer to a bad cursor.
      await useCase.history(RIDER, dto({ cursor: 'not-a-cursor', status: ['REQUESTED'] }));

      expect(only().cursor).toBeUndefined();
    });

    it('forwards the limit unchanged', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto({ limit: 1, status: ['REQUESTED', 'ACCEPTED'] }));

      // `limit: 1` is how a home screen asks "do I have an active ride?" — the
      // cheapest possible form of the question.
      expect(only().limit).toBe(1);
    });
  });
});

describe('ListRidesUseCase.availableToDriver', () => {
  it('is a single status, not a list, and ignores any requested filter', async () => {
    const { useCase, only } = stub();

    await useCase.availableToDriver(DRIVER, dto({ status: ['ACCEPTED', 'IN_PROGRESS'] }));

    // Offers are pending rides by definition, so a caller-supplied status is not
    // honoured. The alternative — honouring it — would let a driver list
    // in-progress rides of other drivers as though they were offers.
    expect(only().status).toBe('REQUESTED');
    expect(only().statuses).toBeUndefined();
  });

  it('is scoped to nobody, because a driver is not a participant in an offer', async () => {
    const { useCase, only } = stub();

    await useCase.availableToDriver(DRIVER, dto());

    expect(only().riderId).toBeUndefined();
    expect(only().driverId).toBeUndefined();
  });

  it('rejects a rider', async () => {
    const { useCase } = stub();

    await expect(useCase.availableToDriver(RIDER, dto())).rejects.toThrow();
  });
});
