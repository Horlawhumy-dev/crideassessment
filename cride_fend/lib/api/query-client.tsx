'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { RETRY_DELAYS, shouldRetry } from './query-keys';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A ride in progress changes without warning. Stale-while-revalidate
        // would show a status the backend moved on from, and the whole point of
        // the version field is that the client's belief is provisional.
        staleTime: 0,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay: (attempt) => RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1],
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: false,
        // A duplicate accept is a 409, not a retryable failure.
        scope: { id: 'session' },
      },
    },
  });
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // useState, not a module-level singleton: a client created at import time is
  // shared by every render pass in dev's fast refresh and leaks one user's
  // cache into the next request during SSR.
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
