import { z } from 'zod';

/**
 * Deliberately tiny: the shape exists so the generated client types the body instead of
 * inventing `{ available: true }` and taking a 400 at runtime.
 */
export const setAvailabilitySchema = z.object({
  isAvailable: z.boolean(),
});

export type SetAvailabilityDto = z.infer<typeof setAvailabilitySchema>;
