'use client';

import { RequireRole } from '@/app/guards/require-role';
import { AppShell } from '@/components/layout/app-shell';
import { SettingsScreen } from '@/features/settings/settings-screen';
import { useSession } from '@/lib/session/session';

/**
 * Settings is reachable by both roles, so this route group sits outside `(rider)`
 * and `(driver)`. The shell still needs a role to pick its nav, and it reads the
 * one the guard has already resolved.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole allowed={['RIDER', 'DRIVER']}>
      <SettingsShell>{children}</SettingsShell>
    </RequireRole>
  );
}

function SettingsShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  if (!session.user) return null;
  return (
    <AppShell role={session.user.role} displayName={session.user.displayName}>
      {children}
    </AppShell>
  );
}
