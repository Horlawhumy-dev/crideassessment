'use client';

import { useSession } from '@/lib/session/session';
import { RiderHome } from '@/features/rides/rider-home';

export default function RiderPage() {
  // The guard in the layout has already resolved the session, so this read is a
  // cache hit rather than a second request.
  const session = useSession();

  return (
    <div className="flex flex-col gap-4">
      <header className="pt-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {greeting()}, {session.user?.displayName.split(/\s+/)[0] ?? 'there'}
        </h1>
        <p className="text-muted-foreground text-sm">Where are you going in Osogbo?</p>
      </header>
      <RiderHome />
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
