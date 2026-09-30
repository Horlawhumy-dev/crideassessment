import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';
import type { RideStatus } from '@/lib/types';
import { RIDE_STATUS_META, type Tone } from '@/lib/ride-status';

/**
 * The one component allowed to decide a status's colour.
 *
 * The TONE map is exhaustive over `Tone`, and `StatusBadge`'s own variant is
 * `Partial<Record<Tone, …>>` derived from it — so a tone that has no style
 * cannot be passed. More importantly, `RIDE_STATUS_META` is keyed by
 * `Record<RideStatus, …>`, so when `npm run gen:api` brings back a sixth status
 * this file stops compiling. A missing tone is a build error, not a badge that
 * silently renders grey.
 *
 * Which is the opposite of the previous app, where `getStatusColor()` returned
 * `'bg-yellow-100 text-yellow-800'` for a status named `'Arriving'` that no
 * enum in the system contained.
 */

const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground ring-border',
  info: 'bg-info-soft text-info ring-info/25',
  warning: 'bg-warning-soft text-warning ring-warning/25',
  success: 'bg-success-soft text-success ring-success/25',
  destructive: 'bg-destructive/10 text-destructive ring-destructive/25',
};

const TONE_SOLID: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground ring-border',
  info: 'bg-info text-info-foreground ring-info/40',
  warning: 'bg-warning text-warning-foreground ring-warning/40',
  success: 'bg-success text-success-foreground ring-success/40',
  destructive: 'bg-destructive text-white ring-destructive/40',
};

const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset', {
  variants: {
    tone: {
      neutral: TONE_SOFT.neutral,
      info: TONE_SOFT.info,
      warning: TONE_SOFT.warning,
      success: TONE_SOFT.success,
      destructive: TONE_SOFT.destructive,
    },
    emphasis: {
      soft: '',
      solid: '',
    },
    size: {
      sm: 'px-2 py-0.5 text-[0.7rem]',
      md: 'px-2.5 py-1 text-xs',
      lg: 'px-3 py-1.5 text-sm',
    },
  },
  compoundVariants: [
    { tone: 'neutral', emphasis: 'solid', class: TONE_SOLID.neutral },
    { tone: 'info', emphasis: 'solid', class: TONE_SOLID.info },
    { tone: 'warning', emphasis: 'solid', class: TONE_SOLID.warning },
    { tone: 'success', emphasis: 'solid', class: TONE_SOLID.success },
    { tone: 'destructive', emphasis: 'solid', class: TONE_SOLID.destructive },
  ],
  defaultVariants: { tone: 'neutral', emphasis: 'soft', size: 'md' },
});

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, emphasis = 'soft', size = 'md', ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, emphasis, size }), className)} {...props} />;
}

interface StatusBadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
  status: RideStatus;
  size?: BadgeProps['size'];
  emphasis?: BadgeProps['emphasis'];
  /** Append the description as a title attribute. Useful on a dense list. */
  withTooltip?: boolean;
}

export function StatusBadge({ status, size = 'md', emphasis = 'soft', withTooltip, className, ...props }: StatusBadgeProps) {
  const meta = RIDE_STATUS_META[status];
  return (
    <span
      className={cn(badgeVariants({ tone: meta.tone, emphasis, size }), className)}
      title={withTooltip ? meta.description : undefined}
      {...props}
    >
      {status === 'REQUESTED' && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {meta.label}
    </span>
  );
}

/**
 * A live connection or availability dot.
 *
 * The tone-to-class map is written out rather than built with a template
 * literal: Tailwind extracts class names by scanning source, so `bg-${tone}`
 * produces a class that exists in the token list and not in the stylesheet, and
 * the dot renders with no colour at all — silently, because nothing errors.
 */
const DOT_FILL: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  info: 'bg-info',
  warning: 'bg-warning',
  success: 'bg-success',
  destructive: 'bg-destructive',
};

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0" aria-hidden>
      {pulse && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', DOT_FILL[tone])} />}
      <span className={cn('relative inline-flex size-2 rounded-full', DOT_FILL[tone])} />
    </span>
  );
}
