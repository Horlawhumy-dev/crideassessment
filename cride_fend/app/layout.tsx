import type { Metadata, Viewport } from 'next';

import { Providers } from '@/lib/providers';

import './globals.css';

/**
 * The root layout, and it does three things.
 *
 * It does not fetch. §5.2: the session lives in cookies that are HttpOnly, and
 * reading them on the server would mean a `cookies()` call in every render plus a
 * `no-store` boundary around the whole tree. Instead `Providers` asks `/auth/me`
 * once, through the BFF, and the role guards in the route-group layouts read the
 * result. One request, in the browser, where the cookie actually is.
 *
 * It does not know what a role is. There is no `if (role === ...)` here; the
 * shells are in `(rider)` and `(driver)`, each with its own layout and its own
 * guard, so being the wrong kind of user is a redirect rather than a surprise.
 */

export const metadata: Metadata = {
  title: {
    default: 'C-Ride — rides across Osogbo',
    template: '%s · C-Ride',
  },
  description:
    'Request a ride in Osogbo, Osun State. C-Ride connects riders with nearby drivers and shows you the whole trip, live.',
  applicationName: 'C-Ride',
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1518' },
  ],
  width: 'device-width',
  initialScale: 1,
  // §5.10: the map is the interface for a rider, so pinching to zoom it must not
  // also zoom the page out from under them.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
