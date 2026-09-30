import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../kernel/page-cursor';

/**
 * `Boolean("false")` is `true`, so `?unreadOnly=false` would silently mean "only the
 * unread ones" — the opposite of what was asked, delivered as a right answer. Accepting
 * only the two literals that appear in a URL makes `?unreadOnly=yes` a 400 instead.
 */
const booleanParam = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true'));

export const listNotificationsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  unreadOnly: booleanParam.optional().default(false),
});

export type ListNotificationsDto = z.infer<typeof listNotificationsSchema>;