'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useSession } from '@/lib/session/session';

/**
 * `/` — the entry point, and a redirect rather than a landing page.
 *
 * It redirects on the *role*: `/auth/me` is fetched once, a rider goes to
 * `/rider`, a driver to `/driver`, and anyone signed out to `/signin`. The old
 * app rendered three links (`/rider`, `/driver`, `/auth`) regardless of who was
 * signed in, so a rider who was already authenticated still had to choose their
 * own dashboard from a list — and a Rider who picked `/driver` got a broken
 * screen, because nothing checked.
 *
 * Something is rendered while loading, because a blank page during a session
 * lookup is indistinguishable from a broken app on a slow connection.
 */
export default function RootPage() {
  const router = useRouter();
  const session = useSession();

  useEffect(() => {
    if (session.isLoading) return;
    router.replace(
      session.isAuthenticated && session.role === 'DRIVER' ? '/driver' : session.isAuthenticated ? '/rider' : '/signin',
    );
  }, [router, session.isLoading, session.isAuthenticated, session.role]);

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3">
        <div className="bg-primary text-primary-foreground grid size-11 place-items-center rounded-2xl text-lg font-semibold">
          C
        </div>
        <p className="text-muted-foreground text-sm">Checking your session…</p>
      </div>
    </div>
  );
}
