import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Inbox, RefreshCw, WifiOff } from 'lucide-react';
import type { ComponentProps } from 'react';

import { ApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

/**
 * The three states every data-backed screen needs, and the reason the previous
 * app had none of them: it rendered `rides.length === 0` and the user could not
 * tell a genuine empty history from a failed fetch, because the failure was
 * swallowed by an `any`-typed `lib/api.ts`.
 *
 * `ErrorState` takes an `ApiError` and never asks the caller to translate one.
 * The distinction it draws — retryable versus not — comes from the error's own
 * codes, so "try again" is only ever offered when trying again can work.
 */

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-14 text-center', className)}>
      <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-2xl">
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description && <p className="text-muted-foreground mx-auto max-w-sm text-sm leading-relaxed">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
  title,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  title?: string;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const canRetry = onRetry ? (apiError ? apiError.isTransient || apiError.isConflict : true) : false;
  const icon = apiError?.isNetwork ? WifiOff : AlertTriangle;

  return (
    <div
      role="alert"
      className={cn('border-destructive/25 bg-destructive/5 flex flex-col items-center gap-3 rounded-2xl border px-6 py-10 text-center', className)}
    >
      <div className="bg-destructive/10 text-destructive flex size-12 items-center justify-center rounded-2xl">
        {(() => {
          const Icon = icon;
          return <Icon className="size-5" aria-hidden />;
        })()}
      </div>

      <div className="space-y-1">
        <p className="font-medium">{title ?? (apiError ? headlineFor(apiError) : 'Something went wrong')}</p>
        <p className="text-muted-foreground mx-auto max-w-md text-sm leading-relaxed">
          {apiError?.displayMessage ?? 'An unexpected error occurred.'}
        </p>
        {/* The correlation id, not a stack trace. It is what makes a report
            actionable, and it is the one piece of the raw error worth showing. */}
        {apiError?.debugHint && <p className="text-muted-foreground/70 pt-1 font-mono text-xs">{apiError.debugHint}</p>}
      </div>

      {canRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="border-border hover:bg-muted mt-1 inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors"
        >
          <RefreshCw className="size-3.5" aria-hidden />
          Try again
        </button>
      )}
    </div>
  );
}

function headlineFor(error: ApiError): string {
  if (error.isNetwork) return 'Cannot reach C-Ride';
  if (error.isUnauthenticated) return 'Your session has ended';
  if (error.isRateLimited) return 'Slow down a moment';
  if (error.isForbidden) return 'Not available to you';
  if (error.isConflict) return 'That just changed';
  return 'Something went wrong';
}

/** The full-bleed page-level versions, for use in a route. */
export function PageError(props: ComponentProps<typeof ErrorState>) {
  return <ErrorState className="my-8" {...props} />;
}
