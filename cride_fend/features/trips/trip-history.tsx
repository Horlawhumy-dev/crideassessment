'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { useState } from 'react';

import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/query-keys';
import { formatDateTime, formatMoney, rideReference } from '@/lib/format';
import { RIDE_STATUS_META } from '@/lib/ride-status';
import type { Ride, RideStatus, UserRole } from '@/lib/types';

/**
 * Trip history, for both roles.
 *
 * One component, not two. The old app had a `history` page for riders and an
 * "earnings" table for drivers, which showed the same data with different words
 * and no way to see a fare for a specific date.
 *
 * Pagination is the backend's keyset cursor, used as a keyset. The previous
 * implementation fetched `?page=2` and passed it as `?cursor=2`, which is not a
 * cursor — it is a guess. Keyset pagination is stable under inserts, which is the
 * entire reason the backend has it: a rider who requests a trip mid-scroll should
 * not see the row they were reading jump off the page.
 */
export function TripHistory({ role }: { role: UserRole }) {
  const [statusFilter, setStatusFilter] = useState<'' | RideStatus>('');

  const query = useInfiniteQuery({
    // No userId in the key or the request: `/rides/history` is already scoped to
    // the caller, so sending one would be a filter the server does not accept and
    // a cache entry that is wrong the moment someone else uses this browser.
    queryKey: queryKeys.ride.list({ status: statusFilter }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.rides.listHistory({
        signal,
        cursor: pageParam,
        limit: 20,
        status: statusFilter || undefined,
      }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor ?? undefined : undefined),
  });

  const rides = query.data?.pages.flatMap((page) => page.items) ?? [];
  const totalMinor = rides.reduce((sum, ride) => sum + Number(ride.fare?.amountMinor ?? 0), 0);
  const isDriver = role === 'DRIVER';

  if (query.isPending) {
    return (
      <div className="space-y-2.5" aria-busy>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20 w-full rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Your trips</h1>
          <p className="text-muted-foreground text-sm">
            {rides.length} trip{rides.length === 1 ? '' : 's'}
            {isDriver && rides.length > 0 && ` · ${formatMoney({ amountMinor: String(totalMinor), currency: 'NGN' })} in fares`}
          </p>
        </div>

        <div className="flex gap-1.5" role="group" aria-label="Filter trips by status">
          <FilterChip active={statusFilter === ''} onClick={() => setStatusFilter('')}>
            All
          </FilterChip>
          {(['COMPLETED', 'CANCELLED'] as const).map((status) => (
            <FilterChip key={status} active={statusFilter === status} onClick={() => setStatusFilter(status)}>
              {status === 'COMPLETED' ? 'Completed' : 'Cancelled'}
            </FilterChip>
          ))}
        </div>
      </div>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rides.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={statusFilter ? `No ${statusFilter.toLowerCase()} trips` : 'No trips yet'}
          description={
            isDriver
              ? 'Accepted rides will appear here with the fare for each one.'
              : 'The rides you request will be listed here, newest first.'
          }
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2.5">
            {rides.map((ride) => (
              <TripRow key={ride.id} ride={ride} />
            ))}
          </ul>

          {query.hasNextPage && (
            <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function TripRow({ ride }: { ride: Ride }) {
  return (
    <li className="bg-card flex items-center gap-3 rounded-2xl border border-border p-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{ride.pickupAddress ?? 'Pickup'}</p>
          <span className="text-muted-foreground font-mono text-[0.7rem]">{rideReference(ride.id)}</span>
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {ride.dropoffAddress ?? 'Dropoff'} · {formatDateTime(ride.createdAt)}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <p className="text-sm font-semibold tabular-nums">{formatMoney(ride.fare)}</p>
        <StatusBadge status={ride.status} size="sm" title={RIDE_STATUS_META[ride.status].description} />
      </div>
    </li>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
