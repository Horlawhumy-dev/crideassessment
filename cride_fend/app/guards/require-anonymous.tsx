'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useSession } from '@/lib/session/session';

/**
 * The signed-out guard.
 *
 * While the session is loading it renders a placeholder rather than redirecting.
 * Redirecting during the load is the bug in most hand-rolled guards: `/auth/me`
 * has not answered yet, so "not authenticated" and "not known yet" look
 * identical, and a signed-in user who lands on `/signin` gets bounced out by a
 * flash of the sign-in form. The previous `app/auth/page.tsx` had no guard at
 * all, which is why `/rider` rendered an empty shell for anyone signed out.
 */
export function RequireAnonymous({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = useSession();

  useEffect(() => {
    // `isUnresolved` too: the check did not complete, so we do not know. Treating
    // that as signed out would show the sign-in form to somebody with a live
    // session, and the moment `/auth/me` recovers RequireRole bounces them back.
    if (session.isLoading || session.isUnresolved) return;
    if (session.isAuthenticated) {
      router.replace(session.role === 'DRIVER' ? '/driver' : '/rider');
    }
  }, [router, session.isLoading, session.isUnresolved, session.isAuthenticated, session.role]);

  if (session.isLoading || session.isUnresolved) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
}
