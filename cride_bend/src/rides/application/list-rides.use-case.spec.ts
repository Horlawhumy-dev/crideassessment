import { ListRidesUseCase } from './list-rides.use-case';
import type { ListRidesFilter, RideRepository } from './ports/ride.repository';
import type { Principal } from '../../auth/principal';
import type { ListRidesDto } from '../dto/list-rides.dto';
import { encodeCursor } from '../../kernel/page-cursor';

/** The "what is my current ride?" query. Three ways to get it wrong, none of which throw:
 *  dropping statuses, dropping the rider/driver scope, or passing `status` where the port
 *  reads `statuses`. The filter handed to the repository is the only place that shows. */

const RIDER: Principal = { userId: 'rider-1', role: 'RIDER', sessionId: 'sess-1' };
const DRIVER: Principal = { userId: 'driver-1', role: 'DRIVER', sessionId: 'sess-2' };

function emptyPage() {
  return { items: [], nextCursor: null, hasMore: false };
}

interface Stub {
  useCase: ListRidesUseCase;
  /** The one filter the repository was asked for. The call count is asserted too: a second
   *  `findMany` is a second query nobody asked for. */
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

      // Every one, in order: sending only the first still compiles and still returns
      // 200, it just tells a rider with an accepted ride that they have no active ride.
      expect(only().statuses).toEqual(['REQUESTED', 'ACCEPTED', 'IN_PROGRESS']);
    });

    it('never sets the singular `status` alongside the list', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto({ status: ['ACCEPTED', 'IN_PROGRESS'] }));

      // Both fields are valid port filters; setting both leaves the repository's
      // precedence unstated, and fake and Postgres would answer differently.
      expect(only().status).toBeUndefined();
    });

    it('omits `statuses` entirely when no filter was requested', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto());

      // Not `statuses: []`. An empty array and an absent key are different queries:
      // an empty `in ()` matches nothing.
      expect('statuses' in only()).toBe(false);
    });

    it('omits `statuses` when the DTO parses an empty value to undefined', async () => {
      const { useCase, only } = stub();

      // `?status=` with nothing after it: the DTO makes that `undefined`, and the
      // spread guard must keep it out of the filter entirely.
      await useCase.history(RIDER, dto({ status: undefined }));

      expect('statuses' in only()).toBe(false);
    });
  });

  describe('scoping', () => {
    it('scopes a rider to their own rides, alongside the status filter', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto({ status: ['ACCEPTED'] }));

      // The dangerous regression: a status filter that quietly replaced the rider scope
      // would list other people's accepted rides.
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

      // The cursor is a repository concept; forwarding the use case's string as if it
      // were one would put the keyset boundary in two places that could disagree.
      expect(only().cursor).toEqual({ createdAt: '2026-09-30T10:00:00.000Z', id: 'ride-9' });
    });

    it('rejects a malformed cursor instead of silently restarting at page 1', async () => {
      const { useCase } = stub();

      // Coercing a bad cursor to `undefined` answers the *first* page to a request
      // for "the next 20". A client paging a history then loops on page one for ever,
      // which is quieter and harder to diagnose than a 400. INVALID_CURSOR was
      // already registered and documented on these routes; nothing threw it.
      await expect(
        useCase.history(RIDER, dto({ cursor: 'not-a-cursor', status: ['REQUESTED'] })),
      ).rejects.toThrow(/cursor/i);
    });

    it('treats an absent cursor as the first page, not as an error', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto({ status: ['REQUESTED'] }));

      expect(only().cursor).toBeUndefined();
    });

    it('forwards the limit unchanged', async () => {
      const { useCase, only } = stub();

      await useCase.history(RIDER, dto({ limit: 1, status: ['REQUESTED', 'ACCEPTED'] }));

      // `limit: 1` is how a home screen asks "do I have an active ride?"
      expect(only().limit).toBe(1);
    });
  });
});

describe('ListRidesUseCase.availableToDriver', () => {
  it('is a single status, not a list, and ignores any requested filter', async () => {
    const { useCase, only } = stub();

    await useCase.availableToDriver(DRIVER, dto({ status: ['ACCEPTED', 'IN_PROGRESS'] }));

    // Offers are pending rides by definition, so a caller-supplied status is not
    // honoured; honouring it would list other drivers' in-progress rides as offers.
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
