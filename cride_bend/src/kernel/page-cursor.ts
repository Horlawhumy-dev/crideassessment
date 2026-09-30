/** Keyset pagination: offset degrades on the ever-growing ride-history query. */
export interface PageCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: PageCursor | null;
  readonly hasMore: boolean;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function encodeCursor(c: PageCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): PageCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as PageCursor).createdAt === 'string' &&
      typeof (parsed as PageCursor).id === 'string'
    ) {
      return parsed as PageCursor;
    }
    return null;
  } catch {
    return null;
  }
}

export function clampPageSize(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), MAX_PAGE_SIZE);
}

export function pageOf<T>(
  items: readonly T[],
  limit: number,
  toCursor: (item: T) => PageCursor,
): Page<T> {
  const hasMore = items.length > limit;
  const trimmed = hasMore ? items.slice(0, limit) : items;
  const last = trimmed.at(-1);

  return {
    items: trimmed,
    hasMore,
    nextCursor: hasMore && last ? toCursor(last) : null,
  };
}
