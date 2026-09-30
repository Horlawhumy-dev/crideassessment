import { z } from 'zod';
import { RIDE_STATUSES } from '../domain/ride-status';

export const transitionRideSchema = z.object({
  to: z.enum(RIDE_STATUSES),
  /**
   * §4.5.2c. Optional so the first client works, but required for correctness:
   * without it a stale tab silently wins a last-writer-wins race.
   */
  version: z.number().int().min(1).optional(),
  /** Recorded on the ride and in the audit trail; shown to the other party. */
  reason: z.string().trim().max(280).optional(),
});

export type TransitionRideDto = z.infer<typeof transitionRideSchema>;
