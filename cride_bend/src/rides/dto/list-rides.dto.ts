import { z } from 'zod';
import { RIDE_STATUSES, type RideStatus } from '../domain/ride-status';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../kernel/page-cursor';

/** `status` takes a comma-separated list as well as a single value, so
 *  `?status=REQUESTED,ACCEPTED,IN_PROGRESS` answers "what is my current ride?" in one request
 *  — the first question both home screens ask. An unknown value is a validation error. */
const statusList = z
  .string()
  .transform((value, ctx) => {
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length === 0) return undefined;

    const valid = new Set<string>(RIDE_STATUSES);
    const invalid = parts.filter((part) => !valid.has(part));
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown ride status: ${invalid.join(', ')}. Expected one of ${RIDE_STATUSES.join(', ')}.`,
      });
      return z.NEVER;
    }

    // Deduplicated, so a client bug does not change the shape of the `IN` clause.
    return [...new Set(parts)] as RideStatus[];
  })
  .optional();

export const listRidesSchema = z.object({
  status: statusList,
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type ListRidesDto = {
  status?: RideStatus[];
  cursor?: string;
  limit: number;
};
