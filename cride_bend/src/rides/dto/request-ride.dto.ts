import { z } from 'zod';

/** The backend schema is authoritative; the client keeps a mirror for fast feedback. Response
 *  types are generated from the OpenAPI document, so no response DTO is hand-written here. */
const coordinate = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const requestRideSchema = z.object({
  pickup: coordinate,
  dropoff: coordinate,
  pickupAddress: z.string().trim().max(280).optional(),
  dropoffAddress: z.string().trim().max(280).optional(),
  note: z.string().trim().max(280).optional(),
});

export type RequestRideDto = z.infer<typeof requestRideSchema>;
