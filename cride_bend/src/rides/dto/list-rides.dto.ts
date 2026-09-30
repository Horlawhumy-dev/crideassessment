import { z } from 'zod';
import { RIDE_STATUSES, type RideStatus } from '../domain/ride-status';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../kernel/page-cursor';

/**
 * `status` takes a comma-separated list as well as a single value: `?status=ACCEPTED,IN_PROGRESS`.
 *
 * This is additive — a single value still works — and it exists for one reason:
 * "what is my current ride?" is the first question both the rider's and the
 * driver's home screen ask, and the answer is "the one in REQUESTED, ACCEPTED or
 * IN_PROGRESS". Asking for that with a single-value filter means three requests
 * from the home screen, or a client-side filter over one page, which is wrong
 * because it is a status the server is authoritative about.
 *
 * The `@@index([riderId, status])` on Ride already exists for precisely this
 * lookup, so this is a query the database was indexed for and the API declined
 * to expose.
 *
 * An unknown value is a validation error rather than being silently dropped: a
 * typo in a filter that returns *more* rows than expected is a wrong answer
 * presented as a right one.
 */
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

    // Deduplicated: `?status=ACCEPTED,ACCEPTED` is a client bug, and it should not
    // change the shape of the generated `IN` clause.
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
