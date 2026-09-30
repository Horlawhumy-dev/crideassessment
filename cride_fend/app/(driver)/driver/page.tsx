'use client';

import { useSession } from '@/lib/session/session';
import { DriverHome } from '@/features/driver/driver-home';

export default function DriverPage() {
  const session = useSession();
  const user = session.user;

  if (!user) return null;

  return <DriverHome driverId={user.id} displayName={user.displayName} />;
}
