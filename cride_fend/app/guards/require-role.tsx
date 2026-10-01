'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, type ReactNode } from 'react';

import { useSession } from '@/lib/session/session';
import type { UserRole } from '@/lib/types';

/**
 * The signed-in guard, and it checks the role as well as the session.
 *
 * `role` is typed `UserRole`, so a component asking for `role="admin"` would not
 * compile. That is the point: the old `c-ride.tsx` compared against `'admin'` —
 * a value the type cannot hold — so the comparison was always false and the
 * whole branch was dead code. Nothing about a role is a bare string comparison
 * here, and the check happens once, in a layout, rather than in every screen.
 *
 * A rider who navigates to `/driver` is redirected to their own dashboard. A
 * forbidden screen is not an error page; it is a sign that the URL was wrong.
 *
 * `allowed` takes an array for the two screens both roles may see (settings), and
 * that is the only reason it is not simply a single value.
 */
export function RequireRole({
  role,
  allowed,
  children,
}: {
  role?: UserRole;
  allowed?: readonly UserRole[];
  children: ReactNode;
}) {
  const router = useRouter();
  const session = useSession();

  /**
   * The allowed set is the same value on every render, so this does not re-fire.
   *
   * It was previously `allowed ?? [role]` computed inline, which allocates a fresh
   * array each render — and `permitted` is in the effect's dependency list. A new
   * array identity on every render meant the effect ran on every render, and for a
   * signed-out visitor `router.replace('/signin')` fired each time. That is a
   * redirect loop the router only tolerates because the second navigation lands on
   * a different route; it burns history entries and makes the guard's behaviour
   * depend on navigation timing.
   */
  const permitted = useMemo<readonly UserRole[] | null>(
    () => allowed ?? (role ? [role] : null),
    [allowed, role],
  );

  const roleIsPermitted = permitted ? permitted.includes(session.role as UserRole) : true;

  useEffect(() => {
    if (session.isLoading || session.isUnresolved) return;

    if (!session.isAuthenticated) {
      router.replace('/signin');
      return;
    }

    if (permitted && !roleIsPermitted) {
      router.replace(session.role === 'DRIVER' ? '/driver' : '/rider');
    }
  }, [router, permitted, roleIsPermitted, session.isLoading, session.isUnresolved, session.isAuthenticated, session.role]);

  const allowedHere = session.isAuthenticated && roleIsPermitted;

  if (session.isLoading || !allowedHere) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="bg-primary size-8 animate-pulse rounded-xl" />
          <p className="text-muted-foreground text-sm">Loading C-Ride…</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
