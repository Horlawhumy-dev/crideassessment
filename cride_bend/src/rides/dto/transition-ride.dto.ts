import { z } from 'zod';
import { RIDE_STATUSES } from '../domain/ride-status';

export const transitionRideSchema = z.object({
  to: z.enum(RIDE_STATUSES),
  /** Optional for convenience, but omitting it opts into last-writer-wins: a stale tab
   *  silently wins the race instead of getting RIDE_VERSION_CONFLICT. */
  version: z.number().int().min(1).optional(),
  /** Recorded on the ride and in the audit trail; shown to the other party. */
  reason: z.string().trim().max(280).optional(),
});

export type TransitionRideDto = z.infer<typeof transitionRideSchema>;
