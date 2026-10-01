import { z } from 'zod';

/** Deliberately tiny: it exists so the generated client types the body instead of inventing `{ available: true }`. */
export const setAvailabilitySchema = z.object({
  isAvailable: z.boolean(),
});

export type SetAvailabilityDto = z.infer<typeof setAvailabilitySchema>;
