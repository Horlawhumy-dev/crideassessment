'use client';

import { Check, Clock, MapPin, Navigation, Phone, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { distanceMetres, formatClockTime, formatDistance, formatMoney, rideReference } from '@/lib/format';
import { ACTION_LABEL, RIDE_STATUS_META, allowedActions, type RideStatus } from '@/lib/ride-status';
import type { DriverLocation, Ride, UserRole } from '@/lib/types';

/**
 * The ride card. One card, both roles, one source of truth.
 *
 * The previous app had two entirely separate implementations — a "RiderDashboard"
 * and a "DriverDashboard" — with their own status wording, their own colour
 * mapping and their own action buttons, which is why the same ride read
 * differently depending on which screen you were on. Here the state machine
 * decides the wording, the tokens decide the colour, and the actions come from
 * `allowedActions`, which mirrors the backend's own policy. A button appears
 * because the transition is legal, not because someone remembered to add it.
 *
 * The rider's Cancel button is the visible payoff of that: `allowedActions` says
 * a rider may only cancel while `REQUESTED`, because §4.13 forbids cancelling
 * once a driver is committed. The old dashboard offered Cancel on an in-progress
 * ride and then showed the user a 409.
 */

const TIMELINE: readonly RideStatus[] = ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED'];

export function RideTimeline({ status }: { status: RideStatus }) {
  if (status === 'CANCELLED') {
    return (
      <p className="text-destructive bg-destructive/5 flex items-center gap-2 rounded-lg p-2.5 text-sm">
        <X className="size-4 shrink-0" aria-hidden />
        This ride was cancelled.
      </p>
    );
  }

  const currentIndex = TIMELINE.indexOf(status);
  const progress = RIDE_STATUS_META[status].progress;

  return (
    <ol className="flex items-center" aria-label="Ride progress">
      {TIMELINE.map((step, index) => {
        const done = index < currentIndex;
        const current = index === currentIndex;
        const meta = RIDE_STATUS_META[step];
        return (
          <li key={step} className="flex flex-1 items-center last:flex-none" aria-current={current ? 'step' : undefined}>
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={[
                  'grid size-6 place-items-center rounded-full border text-[0.65rem] font-semibold transition-colors',
                  done ? 'border-success bg-success text-success-foreground' : '',
                  current ? 'border-primary bg-primary text-primary-foreground' : '',
                  !done && !current ? 'border-border bg-background text-muted-foreground' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {done ? <Check className="size-3" aria-hidden /> : index + 1}
              </span>
              <span className={['max-w-16 text-center text-[0.65rem] leading-tight', current ? 'text-foreground font-medium' : 'text-muted-foreground'].join(' ')}>
                {shortLabel(step)}
              </span>
            </div>
            {index < TIMELINE.length - 1 && (
              <span className="mx-1 mb-5 h-0.5 flex-1 overflow-hidden rounded-full bg-border">
                <span
                  className="bg-success block h-full transition-[width] duration-500"
                  style={{ width: index < currentIndex ? '100%' : '0%' }}
                />
              </span>
            )}
          </li>
        );
      })}
      <span className="sr-only">{Math.round(progress * 100)} percent through your trip</span>
    </ol>
  );
}

function shortLabel(status: RideStatus): string {
  switch (status) {
    case 'REQUESTED':
      return 'Finding';
    case 'ACCEPTED':
      return 'On the way';
    case 'IN_PROGRESS':
      return 'Travelling';
    case 'COMPLETED':
      return 'Done';
    default:
      return status;
  }
}

export function RideCard({
  ride,
  role,
  driverLocation,
  pending,
  onTransition,
  onCancel,
  busy,
}: {
  ride: Ride;
  role: UserRole;
  driverLocation: DriverLocation | null;
  pending: RideStatus | null;
  onTransition: (status: RideStatus) => void;
  onCancel?: () => void;
  busy?: boolean;
}) {
  const meta = RIDE_STATUS_META[ride.status];
  /**
   * `allowedActions` answers "is this legal", which is a question about the server.
   * Whether the button can *work* is a question about this screen, and the two are
   * not the same: the driver's offer queue renders the same card for rides nobody
   * has been assigned yet, where cancellation is legal in the abstract and
   * impossible in practice.
   *
   * So an action with no handler is not rendered. A button that looks live and does
   * nothing is worse than a missing one — it costs the driver a tap to discover
   * nothing, and it teaches them not to believe the UI.
   */
  const actions = allowedActions(ride.status, role).filter(
    (action) => action !== 'CANCELLED' || onCancel !== undefined,
  );
  const driver = driverLocation;

  return (
    <article className="bg-card overflow-hidden rounded-2xl border border-border">
      <header className="flex items-start justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusBadge status={ride.status} withTooltip />
            <span className="text-muted-foreground font-mono text-xs">{rideReference(ride.id)}</span>
          </div>
          <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{meta.description}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">{formatMoney(ride.fare)}</p>
          <p className="text-muted-foreground text-[0.7rem]">estimate</p>
        </div>
      </header>

      <div className="p-4">
        <RideTimeline status={ride.status} />
      </div>

      <div className="space-y-2.5 px-4 pb-4">
        <PlaceRow icon={MapPin} label="Pickup" value={ride.pickupAddress ?? 'Pinned location'} tone="success" />
        <PlaceRow icon={Navigation} label="Dropoff" value={ride.dropoffAddress ?? 'Pinned location'} tone="destructive" />
      </div>

      {/**
       * A cancellation is the one outcome a person on either side actually needs
       * explained, and "Cancelled" on its own is not an explanation. The driver
       * screen asks for a reason on the promise that the rider sees it, so this is
       * where that promise is kept.
       *
       * `cancelledBy` distinguishes the two cancellations that look identical from
       * the outside: a rider who gave up waiting, versus a driver who could not
       * complete the trip. They mean opposite things for the person reading it —
       * one is "book again", the other is "nothing was wrong with your request" —
       * so the who is shown even when there is no reason string.
       */}
      {ride.status === 'CANCELLED' && (ride.cancelReason || ride.cancelledBy) && (
        <div className="border-t border-border px-4 py-3 text-sm">
          <p className="text-muted-foreground text-xs">
            {ride.cancelledBy === 'DRIVER'
              ? 'Your driver cancelled this ride'
              : ride.cancelledBy === 'RIDER'
                ? 'You cancelled this ride'
                : 'This ride was cancelled'}
          </p>
          {ride.cancelReason && <p className="mt-1 leading-relaxed">{ride.cancelReason}</p>}
        </div>
      )}

      {ride.status !== 'REQUESTED' && (
        <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs">
          <span className="text-muted-foreground flex items-center gap-1.5">
            <Clock className="size-3.5" aria-hidden />
            {ride.acceptedAt ? `Accepted ${formatClockTime(ride.acceptedAt)}` : `Requested ${formatClockTime(ride.createdAt)}`}
          </span>
          {driver && (
            <span className="text-muted-foreground tabular-nums">
              {formatDistance(distanceMetres(ride.pickup, driver))} from pickup
            </span>
          )}
        </div>
      )}

      {actions.length > 0 && (
        <footer className="flex flex-wrap gap-2 border-t border-border p-4">
          {actions.map((action) => {
            const isCancel = action === 'CANCELLED';
            const isAccept = action === 'ACCEPTED';
            const Icon = ACTION_ICON[action];
            return (
              <Button
                key={action}
                variant={isCancel ? 'outline' : isAccept ? 'destructive' : 'default'}
                size="lg"
                className="touch-target flex-1"
                disabled={busy || pending !== null}
                onClick={() => (isCancel ? onCancel?.() : onTransition(action))}
              >
                {Icon && <Icon aria-hidden />}
                {busy || pending !== null ? 'Working…' : ACTION_LABEL[action]}
              </Button>
            );
          })}
        </footer>
      )}
    </article>
  );
}

const ACTION_ICON: Partial<Record<RideStatus, LucideIcon>> = {
  ACCEPTED: Check,
  IN_PROGRESS: Navigation,
  COMPLETED: Check,
  CANCELLED: X,
};

function PlaceRow({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: 'success' | 'destructive' }) {
  return (
    <div className="flex items-start gap-3">
      <span className="bg-muted text-muted-foreground mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-[0.7rem] tracking-wide uppercase">{label}</p>
        <p className="truncate text-sm font-medium">{value}</p>
      </div>
      <span
        className={['mt-1 size-2 shrink-0 rounded-full', tone === 'success' ? 'bg-success' : 'bg-destructive'].join(' ')}
        aria-hidden
      />
    </div>
  );
}
