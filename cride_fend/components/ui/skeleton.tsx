import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * A loading placeholder.
 *
 * `aria-hidden`, because a screen reader announcing "loading" once per card is
 * noise, and the region containing them already announces its own busy state.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden className={cn('bg-muted animate-pulse rounded-md', className)} {...props} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
