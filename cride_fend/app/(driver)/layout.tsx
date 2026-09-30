'use client';

import { AppShell } from '@/components/layout/app-shell';
import { RequireRole } from '@/app/guards/require-role';
import { useSession } from '@/lib/session/session';

/** The driver route group. The mirror of `(rider)`, and guarded the same way. */
export default function DriverLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole role="DRIVER">
      <DriverShell>{children}</DriverShell>
    </RequireRole>
  );
}

function DriverShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  return <AppShell role="DRIVER" displayName={session.user?.displayName ?? ''}>{children}</AppShell>;
}
