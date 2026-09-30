import { z } from 'zod';

/**
 * The request a rider makes.
 *
 * The coordinate bounds are Osogbo's, and they are chosen to be *wrong* on
 * purpose: the backend rejects a point outside `COORD_VALIDATION` (lat −90…90,
 * lng −180…180) and, more usefully, a pickup 200 m from the dropoff. A form that
 * reproduces the server's rule gives the user an inline message; a form that
 * invents a different one produces a 400 they cannot act on.
 *
 * The previous app sent `{ pickup: 'Osogbo City Mall' }` — a string where the
 * API wants a coordinate object — because nothing checked the shape before the
 * request went out.
 */

const MIN_TRIP_METRES = 200;

export const requestRideSchema = z
  .object({
    pickup: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }),
    dropoff: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }),
    pickupAddress: z.string().max(160).nullable().optional(),
    dropoffAddress: z.string().max(160).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (distanceMetres(value.pickup, value.dropoff) < MIN_TRIP_METRES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dropoff'],
        message: 'Choose a dropoff at least 200 m from your pickup.',
      });
    }
  });

export type RequestRidePayload = z.infer<typeof requestRideSchema>;

function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
