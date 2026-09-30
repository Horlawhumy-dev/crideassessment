'use client';

import { LogOut, MapPin, Receipt, Settings, Star, User, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Dot } from '@/components/ui/badge';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { cn } from '@/lib/utils';
import { useSignOut } from '@/lib/session/session';
import { useRideState } from '@/lib/rides/ride-provider';
import type { UserRole } from '@/lib/types';

/**
 * The app shell.
 *
 * The nav is derived from `role`, which is a union, not a string. The previous
 * `components/c-ride.tsx` checked `role === 'admin'`, a value `UserRole` cannot
 * hold, so the branch was dead and the whole ops section was unreachable — which
 * is exactly what the roadmap said ("I cannot see the dispatcher role, as
 * expected").
 *
 * There is no `Dispatcher` entry here because there is no `Dispatcher` role.
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only while a ride is live, so a rider always knows where their ride is. */
  live?: boolean;
}

const RIDER_NAV: NavItem[] = [
  { href: '/rider', label: 'Ride', icon: MapPin, live: true },
  { href: '/rider/trips', label: 'Trips', icon: Receipt },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const DRIVER_NAV: NavItem[] = [
  { href: '/driver', label: 'Dashboard', icon: Star, live: true },
  { href: '/driver/trips', label: 'Earnings', icon: Receipt },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({
  role,
  displayName,
  children,
}: {
  role: UserRole;
  displayName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const signOut = useSignOut();
  const { connection, state } = useRideState();

  const items = role === 'RIDER' ? RIDER_NAV : DRIVER_NAV;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-background/85 sticky top-0 z-20 border-b border-border backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
          <Link href={role === 'RIDER' ? '/rider' : '/driver'} className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-lg text-sm">C</span>
            <span className="hidden sm:inline">C-Ride</span>
          </Link>

          <ConnectionChip state={connection} />

          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-muted-foreground hidden items-center gap-1.5 pr-1 text-sm sm:flex">
              <User className="size-3.5" aria-hidden />
              {firstName(displayName)}
            </span>
            <NotificationBell />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                signOut.mutate(undefined, {
                  onSettled: () => router.replace('/'),
                });
              }}
            >
              <LogOut aria-hidden />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-4 pb-24">{children}</main>

      {/* A bottom bar on a phone, a top row on a desktop. The driver interface is
          used one-handed, so the primary action is always within thumb reach. */}
      <nav className="bg-background/95 fixed inset-x-0 bottom-0 z-20 border-t border-border backdrop-blur sm:static sm:border-t-0">
        <div className="mx-auto flex w-full max-w-5xl items-stretch sm:justify-start sm:gap-1">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex flex-1 flex-col items-center gap-0.5 px-3 py-2.5 text-xs font-medium transition-colors sm:flex-row sm:gap-2 sm:rounded-lg sm:px-3 sm:py-2',
                  active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="relative">
                  <Icon className="size-4" aria-hidden />
                  {item.live && state.active && (
                    <span className="absolute -top-0.5 -right-0.5">
                      <Dot tone="success" pulse />
                    </span>
                  )}
                </span>
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function ConnectionChip({ state: connection }: { state: ReturnType<typeof useRideState>['connection'] }) {
  // A connection indicator is only shown when there is something to report. A
  // permanent "connected" badge is noise; a "reconnecting" one is information.
  if (connection === 'connected') return null;

  const tone = connection === 'offline' ? 'destructive' : 'warning';
  const label = connection === 'offline' ? 'Offline' : 'Reconnecting…';

  return (
    <span className="bg-muted/70 text-muted-foreground flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
      <Dot tone={tone} pulse />
      {label}
    </span>
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
