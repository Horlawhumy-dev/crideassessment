'use client';

import { SettingsScreen } from '@/features/settings/settings-screen';
import { useSession } from '@/lib/session/session';

export default function SettingsPage() {
  const session = useSession();
  if (!session.user) return null;

  // The session is already in the query cache — the layout's guard fetched it —
  // so this read costs nothing rather than issuing a second `/auth/me`.
  return <SettingsScreen user={session.user} />;
}
