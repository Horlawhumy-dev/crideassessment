'use client';

import { Toaster } from 'sonner';

import { QueryProvider } from '@/lib/api/query-client';
import { RideProvider } from '@/lib/rides/ride-provider';
import { useSession } from '@/lib/session/session';

/**
 * Provider composition, in one place.
 *
 * Order is load-bearing and worth stating:
 *
 *   QueryClient → Sonner (needs the query client to report errors)
 *             → RideProvider (needs a client to refetch on)
 *             → Shell (needs to know whether there is a session)
 *
 * The old app mounted a `ThemeProvider` and a `Toast` component and passed
 * callbacks between them from the root layout, which meant the root had to know
 * about both domains. Here the root knows only this.
 *
 * `RideProvider` is mounted only for a signed-in session, because the socket's
 * handshake is authenticated with the session cookie. Mounting it for an
 * anonymous visitor opens a connection that can only ever 401.
 */

function SessionGate({ children }: { children: React.ReactNode }) {
  const session = useSession();

  if (session.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="bg-primary size-8 animate-pulse rounded-xl" />
          <p className="text-muted-foreground text-sm">Loading C-Ride…</p>
        </div>
      </div>
    );
  }

  if (!session.isAuthenticated || !session.user || !session.role) {
    // Signed out: the socket must not be opened, but the query client and toaster
    // still have to exist, because the sign-in form uses a mutation.
    return <>{children}</>;
  }

  return <RideProvider role={session.role} userId={session.user.id}>{children}</RideProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <Toaster
        position="top-center"
        richColors
        closeButton
        // A ride status must never be announced by a toast, so nothing here
        // announces itself; anything urgent opts in with an `aria-live` region
        // of its own.
        toastOptions={{ duration: 4500 }}
      />
      <SessionGate>{children}</SessionGate>
    </QueryProvider>
  );
}
