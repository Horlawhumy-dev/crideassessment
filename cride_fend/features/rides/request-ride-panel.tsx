'use client';

import { ArrowRight, LocateFixed, MapPin } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, Input, Label, Select } from '@/components/ui/input';
import { ApiError } from '@/lib/api/errors';
import { distanceMetres, estimateDurationMs, formatDistance, formatDuration, formatMoney } from '@/lib/format';
import { DEFAULT_DROPOFF, DEFAULT_PICKUP, OSOGBO_PLACES, placeLabel, type Place } from '@/lib/places';
import type { GeoPoint, Money } from '@/lib/types';
import { requestRideSchema } from './schemas';

/**
 * Request a ride.
 *
 * The two decisions that make this usable rather than merely functional:
 *
 * 1. **Named places plus a map, not a geocoder.** The API takes coordinates and
 *    offers no search, so a form that only accepted a pin would make the
 *    smallest possible journey a fiddly gesture. Nine real Osogbo places plus a
 *    tappable map covers the demo and still accepts anywhere on the map, so the
 *    feature is not narrower than the backend.
 *
 * 2. **The estimate is labelled an estimate, and it is a real calculation.** The
 *    old dashboard showed "Naira 12,400" — a number with no currency formatting,
 *    no minor units and no way to know it came from anywhere. Here the fare comes
 *    back from the server, the estimate before submitting is computed from the
 *    same haversine and the same 30 km/h average the server's policy uses, and
 *    the two are visibly distinct: one is labelled "estimate", the other is
 *    labelled "fare".
 */

export function RequestRidePanel({
  submitting,
  serverError,
  onSubmit,
}: {
  submitting: boolean;
  serverError: ApiError | null;
  onSubmit: (input: { pickup: GeoPoint; dropoff: GeoPoint; pickupAddress?: string; dropoffAddress?: string }) => void;
}) {
  const [pickup, setPickup] = useState<Place>(DEFAULT_PICKUP);
  const [dropoff, setDropoff] = useState<Place>(DEFAULT_DROPOFF);
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const resolved: { pickup: GeoPoint; dropoff: GeoPoint } = point
    ? { pickup: point, dropoff: dropoff.point }
    : { pickup: pickup.point, dropoff: dropoff.point };

  const distance = distanceMetres(resolved.pickup, resolved.dropoff);
  const duration = estimateDurationMs(resolved.pickup, resolved.dropoff);

  function handleSubmit() {
    const candidate = {
      pickup: { lat: resolved.pickup.lat, lng: resolved.pickup.lng },
      dropoff: { lat: resolved.dropoff.lat, lng: resolved.dropoff.lng },
      // Omitted rather than `null`: the generated body type is
      // `pickupAddress?: string`, so a null here is a MISSING_FIELD at the schema.
      ...(point ? {} : { pickupAddress: pickup.label }),
      dropoffAddress: dropoff.label,
    };

    // §4.5.2a: the backend rejects a pickup within 200 m of the dropoff with
    // INVALID_COORDINATES. Checking it here turns a round trip into an inline
    // message — and the check matches the server's, rather than inventing a
    // friendlier threshold that would still fail server-side.
    const candidateErrors = validateCandidate(candidate);
    setErrors(candidateErrors);
    if (Object.keys(candidateErrors).length > 0) return;

    onSubmit(candidate);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where to?</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-center gap-1.5 pt-6" aria-hidden>
            <span className="bg-success size-2.5 rounded-full" />
            <span className="bg-border h-8 w-0.5" />
            <span className="bg-destructive size-2.5 rounded-sm" />
          </div>

          <div className="flex-1 space-y-3">
            <Field invalid={Boolean(errors.pickup)}>
              <Label htmlFor="pickup">Pickup</Label>
              <Select
                id="pickup"
                value={pickup.id}
                disabled={point !== null}
                onChange={(event) => {
                  setPoint(null);
                  setPickup(OSOGBO_PLACES.find((p) => p.id === event.target.value) ?? DEFAULT_PICKUP);
                }}
              >
                {OSOGBO_PLACES.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.label} — {place.area}
                  </option>
                ))}
              </Select>
              {point && (
                <FieldDescription className="flex items-center gap-1.5">
                  <LocateFixed className="size-3" aria-hidden />
                  Using your pin: {placeLabel(point)}
                  <button type="button" className="text-primary underline underline-offset-2" onClick={() => setPoint(null)}>
                    undo
                  </button>
                </FieldDescription>
              )}
              <FieldErrorText message={errors.pickup} />
            </Field>

            <Field invalid={Boolean(errors.dropoff)}>
              <Label htmlFor="dropoff">Dropoff</Label>
              <Select
                id="dropoff"
                value={dropoff.id}
                onChange={(event) => setDropoff(OSOGBO_PLACES.find((p) => p.id === event.target.value) ?? DEFAULT_DROPOFF)}
              >
                {OSOGBO_PLACES.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.label} — {place.area}
                  </option>
                ))}
              </Select>
              <FieldErrorText message={errors.dropoff} />
            </Field>
          </div>
        </div>

        <div className="bg-muted/50 flex items-center justify-between rounded-xl px-3.5 py-3">
          <div>
            <p className="text-sm font-medium tabular-nums">
              {formatDistance(distance)} <span className="text-muted-foreground">·</span>{' '}
              <span className="text-muted-foreground">about {formatDuration(duration)}</span>
            </p>
            <p className="text-muted-foreground mt-0.5 text-[0.7rem]">
              Fare confirmed by C-Ride when you request.
            </p>
          </div>
          <EstimatedFare distanceMetres={distance} />
        </div>

        {serverError && !serverError.isValidation && (
          <p role="alert" className="text-destructive text-sm">
            {serverError.displayMessage}
          </p>
        )}

        <Button size="lg" className="touch-target w-full" onClick={handleSubmit} disabled={submitting}>
          <MapPin aria-hidden />
          {submitting ? 'Requesting…' : 'Request ride'}
          <ArrowRight aria-hidden />
        </Button>
      </CardContent>
    </Card>
  );
}

function FieldErrorText({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <p className="text-destructive text-xs font-medium">{message}</p>;
}

/**
 * A pre-submit estimate on the same scale as the server's.
 *
 * The numbers are the defaults in `env.schema.ts`: a ₦1,500 base, ₦120 per km,
 * ₦25 per minute, a ₦1,000 minimum. They are stated here as an approximation on
 * purpose — a client copy of a pricing policy is always eventually wrong, and
 * the label plus the server's authoritative answer on the card is the honest
 * arrangement. `npm run check:api` is what keeps the real one from drifting.
 */
function EstimatedFare({ distanceMetres: metres }: { distanceMetres: number }) {
  const BASE_MINOR = 1500;
  const PER_KM_MINOR = 120;
  const PER_MINUTE_MINOR = 25;
  const MINIMUM_MINOR = 1000;

  const km = metres / 1000;
  const minutes = (km / 30) * 60;
  const amountMinor = Math.max(MINIMUM_MINOR, Math.round(BASE_MINOR + km * PER_KM_MINOR + minutes * PER_MINUTE_MINOR));

  const money: Money = { amountMinor: String(amountMinor), currency: 'NGN' };

  return (
    <p className="text-right text-lg font-semibold tabular-nums" title="Estimate only. The fare is set by the server.">
      {formatMoney(money)}
    </p>
  );
}

function validateCandidate(candidate: { pickup: GeoPoint; dropoff: GeoPoint }): Record<string, string> {
  const issues: Record<string, string> = {};
  const parsed = requestRideSchema.safeParse(candidate);
  if (parsed.success) return issues;
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? 'form');
    if (!issues[key]) issues[key] = issue.message;
  }
  return issues;
}
