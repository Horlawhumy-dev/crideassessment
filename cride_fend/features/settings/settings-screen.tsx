'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Bell, LogOut, Smartphone, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge, Dot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query-keys';
import { useSignOut } from '@/lib/session/session';
import type { SessionUser } from '@/lib/types';

/**
 * Settings: the three things a person actually needs to change.
 *
 * The old settings page had a theme selector, a notification toggle and a
 * language picker — none of which changed anything. A toggle that does not
 * persist is worse than no toggle, because a user who turns it off and is then
 * still notified has learned that this app's settings are not real.
 *
 * So every control here writes to the server and reads its state back from it.
 * Availability is not here — it lives on the driver dashboard, because that is
 * where it has meaning, and a switch in two places is a switch that disagrees
 * with itself.
 */

export function SettingsScreen({ user }: { user: SessionUser }) {
  const signOut = useSignOut();

  const devices = useQuery({
    queryKey: queryKeys.devices,
    queryFn: ({ signal }) => api.devices.list({ signal }),
  });

  const revokeDevice = useMutation({
    mutationFn: (token: string) => api.devices.revoke(token),
    onSuccess: () => {
      toast.success('Device removed.');
      void devices.refetch();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.displayMessage : 'Could not remove that device.'),
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Row label="Name" value={user.displayName} />
          <Row label="Email" value={user.email} />
          <Row label="Phone" value={user.phone ?? 'Not provided'} />
          <Row
            label="Role"
            value={
              <Badge tone="info" size="sm">
                {user.role === 'RIDER' ? 'Rider' : 'Driver'}
              </Badge>
            }
          />
          {user.role === 'DRIVER' && (
            <Row
              label="Status"
              value={
                <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
                  <Dot tone={user.isAvailable ? 'success' : 'neutral'} pulse={user.isAvailable} />
                  {user.isAvailable ? 'Online' : 'Offline'}
                </span>
              }
            />
          )}
        </CardContent>
      </Card>

      {/* No change-password form, because the API has no such endpoint.
          A form that 404s is worse than no form: a user who sets a new password
          and is told it worked has been actively misled. It is absent here and
          the absence is deliberate — see api/auth for what does exist. */}

      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>
            {devices.data?.pushEnabled === false
              ? 'Push is switched off on this deployment — nothing will be delivered, so the list below is the whole story.'
              : 'Devices that can receive trip notifications.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {devices.isPending ? (
            <p className="text-muted-foreground text-sm">Loading devices…</p>
          ) : devices.isError ? (
            <p className="text-muted-foreground text-sm">
              {devices.error instanceof ApiError ? devices.error.displayMessage : 'Could not load your devices.'}
            </p>
          ) : (devices.data?.items.length ?? 0) === 0 ? (
            <div className="text-muted-foreground flex items-start gap-3 text-sm">
              <Bell className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>
                No devices registered. Ride updates appear in the app while it is open, which is all this build does —
                a browser cannot register for background push without service-worker support in the target browser.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {devices.data?.items.map((device) => (
                <li key={device.token} className="bg-muted/50 flex items-center gap-3 rounded-xl p-3">
                  <Smartphone className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {device.platform === 'web' ? 'This browser' : device.platform}
                    </p>
                    <p className="text-muted-foreground font-mono text-[0.7rem]">
                      {device.token.slice(0, 12)}… · added {new Date(device.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revokeDevice.mutate(device.token)}
                    aria-label="Remove this device"
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Separator />
      <Button variant="outline" className="self-start" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
        <LogOut aria-hidden />
        {signOut.isPending ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}
