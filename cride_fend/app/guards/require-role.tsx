'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

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
  const permitted = allowed ?? (role ? ([role] as readonly UserRole[]) : null);

  useEffect(() => {
    if (session.isLoading) return;

    if (!session.isAuthenticated) {
      router.replace('/signin');
      return;
    }

    if (permitted && !permitted.includes(session.role as UserRole)) {
      router.replace(session.role === 'DRIVER' ? '/driver' : '/rider');
    }
  }, [router, permitted, session.isLoading, session.isAuthenticated, session.role]);

  const allowedHere = session.isAuthenticated && (!permitted || permitted.includes(session.role as UserRole));

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
