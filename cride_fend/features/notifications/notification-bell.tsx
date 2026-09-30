'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Car, Check, CircleUser, Play, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Popover,
  PopoverPopup,
  PopoverPositioner,
  PopoverPortal,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/query-keys';
import { formatRelative } from '@/lib/format';
import { NOTIFICATION_KIND_META } from '@/lib/notification-kind';
import { cn } from '@/lib/utils';
import type { InAppNotification, InAppNotificationKind } from '@/lib/types';

/**
 * The in-app notification centre.
 *
 * This is the half of the notification system that works for a user who never
 * registered for push. `NotificationProcessor` skips anyone with no device token,
 * which is every user of the web build, so a notification centre built on top of
 * the push queue would have shipped permanently empty.
 *
 * Two requests, deliberately, and not one. The badge is a single integer polled
 * on an interval, and the list is fetched when the panel opens. Collapsing them
 * into one query would make every page that mounts the bell download a page of
 * rows to draw a number.
 *
 * The unread count is *not* the list's `unreadCount` read back out of the
 * response. Marking read settles both from the mutation's own return value, which
 * the server computes from the same transaction as the write.
 */
type NotificationListData = { cursor?: string; items: InAppNotification[] };

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const unread = useQuery({
    queryKey: queryKeys.notifications.unreadCount,
    queryFn: ({ signal }) => api.notifications.unreadCount({ signal }),
    // Short enough that a notification arriving in another tab shows up without
    // the user doing anything, long enough that it is not a busy loop on a page
    // left open all day.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const list = useQuery({
    queryKey: queryKeys.notifications.list({}),
    enabled: open,
    staleTime: 10_000,
    retry: false,
    queryFn: async ({ signal }): Promise<NotificationListData> => {
      const page = await api.notifications.list({ signal, limit: 20 });
      return { cursor: page.nextCursor ?? undefined, items: page.items };
    },
  });

  const settle = (unreadCount: number, id?: string) => {
    queryClient.setQueryData(queryKeys.notifications.unreadCount, (previous) =>
      previous ? { ...previous, unreadCount } : previous,
    );
    queryClient.setQueryData<NotificationListData>(queryKeys.notifications.list({}), (previous) => {
      if (!previous) return previous;
      const readAt = new Date().toISOString();
      if (id === undefined) {
        return { ...previous, items: previous.items.map((n) => ({ ...n, readAt: n.readAt ?? readAt })) };
      }
      return {
        ...previous,
        items: previous.items.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? readAt } : n)),
      };
    });
  };

  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: (result) => settle(result.unreadCount, result.id),
  });

  const markAllRead = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: (result) => settle(result.unreadCount),
  });

  const count = unread.data?.unreadCount ?? 0;
  const items = list.data?.items ?? [];
  const hasUnread = count > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={hasUnread ? `Notifications, ${count} unread` : 'Notifications'}>
            <span className="relative">
              <Bell className="size-4" aria-hidden />
              {hasUnread && (
                <span
                  className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 grid min-w-4 place-items-center rounded-full px-1 text-[0.6rem] font-semibold tabular-nums"
                  aria-hidden
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </span>
          </Button>
        }
      />

      <PopoverPortal>
        <PopoverPositioner align="end" sideOffset={8} className="w-[min(22rem,calc(100vw-2rem))]">
          <PopoverPopup>
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <PopoverTitle>Notifications</PopoverTitle>
              {hasUnread && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => markAllRead.mutate()}
                  disabled={markAllRead.isPending}
                >
                  Mark all read
                </Button>
              )}
            </div>

            <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
              {list.isPending ? (
                <div className="space-y-2 p-4" aria-busy>
                  {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-14 w-full rounded-xl" />
                  ))}
                </div>
              ) : list.isError ? (
                <p className="text-muted-foreground p-4 text-sm">
                  Notifications could not be loaded.{' '}
                  <Button variant="link" size="xs" onClick={() => void list.refetch()}>
                    Retry
                  </Button>
                </p>
              ) : items.length === 0 ? (
                <EmptyState
                  icon={BellOff}
                  title="Nothing yet"
                  description="Ride updates for you will show up here."
                  className="border-0"
                />
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((item) => (
                    <NotificationRow
                      key={item.id}
                      notification={item}
                      onRead={() => {
                        if (item.readAt === null) markRead.mutate(item.id);
                        setOpen(false);
                      }}
                    />
                  ))}
                </ul>
              )}
            </div>
          </PopoverPopup>
        </PopoverPositioner>
      </PopoverPortal>
    </Popover>
  );
}

const KIND_ICON: Record<InAppNotificationKind, typeof Bell> = {
  RIDE_REQUESTED: Car,
  RIDE_ACCEPTED: CircleUser,
  RIDE_IN_PROGRESS: Play,
  RIDE_COMPLETED: Check,
  RIDE_CANCELLED: X,
};

function NotificationRow({
  notification,
  onRead,
}: {
  notification: InAppNotification;
  onRead: () => void;
}) {
  const Icon = KIND_ICON[notification.kind];
  const tone = NOTIFICATION_KIND_META[notification.kind].tone;
  const unread = notification.readAt === null;

  return (
    <li>
      <button
        type="button"
        onClick={onRead}
        className={cn(
          'hover:bg-muted/50 focus-visible:bg-muted/50 flex w-full gap-3 px-4 py-3 text-left transition-colors',
          'focus-visible:outline-none',
          unread && 'bg-primary/5',
        )}
      >
        <span
          className={cn(
            'mt-0.5 grid size-8 shrink-0 place-items-center rounded-full',
            tone === 'success' && 'bg-success-soft text-success',
            tone === 'destructive' && 'bg-destructive/10 text-destructive',
            tone === 'warning' && 'bg-warning-soft text-warning',
            tone === 'info' && 'bg-info-soft text-info',
            tone === 'neutral' && 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>

        <span className="min-w-0 flex-1">
          <span className={cn('block text-sm', unread ? 'font-semibold' : 'font-medium')}>
            {notification.title}
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs">{notification.body}</span>
          <span className="text-muted-foreground/70 mt-1 block text-[0.7rem]">
            {formatRelative(notification.createdAt)}
          </span>
        </span>

        {unread && <span className="bg-primary mt-2 size-2 shrink-0 rounded-full" aria-label="Unread" />}
      </button>
    </li>
  );
}
