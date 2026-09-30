'use client';

import { useSession } from '@/lib/session/session';
import { AppShell } from '@/components/layout/app-shell';
import { RequireRole } from '@/app/guards/require-role';

/**
 * The rider route group.
 *
 * The guard and the shell live here, in the layout, so no screen under
 * `(rider)` can be reached without a session or rendered without the shell. The
 * previous app put both inside `components/c-ride.tsx` and then rendered the
 * dashboard through a separate entry point, which is how `/rider` existed as a
 * route with no guard and no nav.
 */
export default function RiderLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole role="RIDER">
      <RiderShell>{children}</RiderShell>
    </RequireRole>
  );
}

function RiderShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  return <AppShell role="RIDER" displayName={session.user?.displayName ?? ''}>{children}</AppShell>;
}
