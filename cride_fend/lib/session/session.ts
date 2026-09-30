'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../api/client';
import { ApiError } from '../api/errors';
import { queryKeys } from '../api/query-keys';
import type { Principal, SessionUser, UserRole } from '../types';

/**
 * The session is the one piece of state the previous app kept in a module-level
 * `let currentUser`, mutated from a `signIn()` helper, and read by a
 * `useAuth()` hook. That cannot work: the module is per-bundle, so a full page
 * load starts with `currentUser === null` and every guard bounces to sign-in
 * until something happens to call `/auth/me`. And `role === 'DRIVER'` checks
 * scattered through components meant a Rider could be shown driver screens.
 *
 * Instead the server is the authority, the query cache is the storage, and the
 * role is a type, not a string comparison.
 */

export type SessionState =
  | { status: 'loading'; user: null; role: null }
  | { status: 'anonymous'; user: null; role: null }
  | { status: 'authenticated'; user: SessionUser; role: UserRole };

interface MeResponse {
  principal: Principal | null;
}

export function useSession() {
  const query = useQuery({
    queryKey: queryKeys.session,
    queryFn: async ({ signal }): Promise<Principal | null> => {
      try {
        return await api.auth.me({ signal });
      } catch (error) {
        // 401 on `/auth/me` means "not signed in". It is an answer, not a failure,
        // and it must not leave the query in an error state that an error boundary
        // then turns into an error page for an ordinary signed-out visitor.
        if (error instanceof ApiError && error.isUnauthenticated) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const user = query.data?.user ?? null;
  const role = user?.role ?? null;

  const state: SessionState =
    query.isPending && query.data === undefined
      ? { status: 'loading', user: null, role: null }
      : user
        ? { status: 'authenticated', user, role: user.role }
        : { status: 'anonymous', user: null, role: null };

  return {
    ...state,
    isLoading: query.isPending && query.data === undefined,
    isAuthenticated: state.status === 'authenticated',
    /** Refetch on window focus: a session revoked in another tab should end this one. */
    refetch: query.refetch,
  };
}

function useSessionMutation<TInput, TResult>(run: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: run,
    onSuccess: async () => {
      // A fresh `/auth/me` rather than trusting the response body: the response
      // carries a token the browser cannot read, and the cached principal is what
      // every guard reads. Rebuilding it from the server is the only way to be
      // sure the role and the availability flag are current.
      await queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
}

export function useSignIn() {
  const run = useSessionMutation(api.auth.login);
  return {
    ...run,
    signIn: (input: Parameters<typeof api.auth.login>[0]) => run.mutateAsync(input),
  };
}

export function useRegister() {
  const run = useSessionMutation(api.auth.register);
  return {
    ...run,
    register: (input: Parameters<typeof api.auth.register>[0]) => run.mutateAsync(input),
  };
}

/**
 * §4.2. The access token is 15 minutes. The refresh path is a *cookie*, so this
 * cannot be done with a timer in the component tree: it has to happen before a
 * request is issued, not after one failed.
 */
export function useRefreshSession() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.auth.refresh(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
  return {
    ...mutation,
    refresh: () => mutation.mutateAsync().catch(() => false as const),
  };
}

export function useSignOut() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.auth.logout(),
    onSettled: async () => {
      // `onSettled`, not `onSuccess`. A logout that fails server-side has still
      // ended the session from the user's point of view, and leaving a stale
      // principal on screen after they pressed "Sign out" is the worse bug.
      queryClient.setQueryData(queryKeys.session, null);
      queryClient.clear();
    },
  });
}
