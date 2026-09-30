import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NotificationNotFoundError } from '../common/errors/domain-error';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { ApiAuthedErrorResponses } from '../common/openapi/api-error-responses';
import {
  InAppNotificationDto,
  InAppNotificationListResponseDto,
  UnreadCountResponseDto,
} from '../common/openapi/api-schemas';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { decodeCursor, encodeCursor, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../kernel/page-cursor';
import type { Principal } from '../rides/domain/ride-policy';
import { listNotificationsSchema, type ListNotificationsDto } from './dto/list-notifications.dto';
import {
  IN_APP_NOTIFICATION_REPOSITORY,
  type InAppNotificationRecord,
  type InAppNotificationRepository,
} from './in-app.repository';

/**
 * The inbox — the notification a user can come back and read. Complements push: FCM
 * reaches a backgrounded app but shows nothing they can scroll back to, and the web build
 * has no token at all.
 *
 * Every route is scoped to the caller by `userId` in the `where` clause rather than by a
 * check someone could forget. Nothing here is cached: the unread count changes on the
 * order of seconds, and caching would trade correctness on the number the user is looking
 * at for latency on an already-indexed count.
 */
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    @Inject(IN_APP_NOTIFICATION_REPOSITORY) private readonly inbox: InAppNotificationRepository,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'listNotifications',
    summary: 'The caller’s inbox, newest first',
    description: [
      'Every notification the caller has been sent, scoped to them: a rider sees their own, a driver',
      'theirs. A notification belonging to someone else is not in this list and is not',
      'distinguishable from one that does not exist.',
      '',
      'Keyset-paginated on `(createdAt DESC, id)`, for the same reason ride history is: an inbox grows',
      'without bound, and an offset would skip or repeat rows whenever a new ride notification arrived',
      'mid-scroll. Follow `nextCursor` until `hasMore` is false.',
      '',
      '`nextCursor` is an opaque string — pass it back verbatim as `?cursor=`. It is encoded here',
      'rather than returned as the raw `(createdAt, id)` pair, because a cursor that goes into a query',
      'string has to survive `URLSearchParams` and come back out the same.',
      '',
      '**The list is eventually consistent.** Rows are written by the outbox relay rather than in the',
      'ride transaction (§4.6), so an entry appears within a few hundred milliseconds of the event and',
      'not in the same millisecond. The socket tells the client the ride changed immediately; this tells',
      'them what they were told about it.',
      '',
      '`unreadCount` covers the whole inbox rather than the returned page, so the badge and the list can',
      'never disagree because one of them was paginated.',
    ].join('\n'),
  })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque cursor from a previous response’s `nextCursor`, passed back verbatim.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Page size. Defaults to ${DEFAULT_PAGE_SIZE}, capped at ${MAX_PAGE_SIZE}.`,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
  })
  @ApiQuery({
    name: 'unreadOnly',
    required: false,
    description: 'Restrict to unread entries. Only `true` and `false` are accepted; anything else is a 400.',
    schema: { type: 'boolean', default: false },
  })
  @ApiOkResponse({ type: InAppNotificationListResponseDto })
  @ApiAuthedErrorResponses('MISSING_FIELD', 'INVALID_CURSOR')
  async list(
    @CurrentUser() principal: Principal,
    @Query(new ZodValidationPipe(listNotificationsSchema)) query: ListNotificationsDto,
  ) {
    // Concurrently: the count is what the badge renders, and it is the number the
    // user is looking at while the page loads.
    const [page, unreadCount] = await Promise.all([
      this.inbox.listFor(principal.userId, {
        unreadOnly: query.unreadOnly,
        cursor: query.cursor ? decodeCursor(query.cursor) : null,
        limit: query.limit,
      }),
      this.inbox.countUnread(principal.userId),
    ]);

    return {
      items: page.items.map(toResponse),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      hasMore: page.hasMore,
      unreadCount,
    };
  }

  @Get('unread-count')
  @ApiOperation({
    operationId: 'countUnreadNotifications',
    summary: 'Unread entries for the caller',
    description: [
      'A separate route so the bell can be drawn without fetching an inbox to draw it. This is one',
      'indexed count; the list route is a page of rows plus the same count.',
      '',
      'Intended to be polled, and cheap enough to: no rows to read, no read state to compute, and it',
      'returns a single integer.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: UnreadCountResponseDto })
  @ApiAuthedErrorResponses()
  async unreadCount(@CurrentUser() principal: Principal) {
    return { unreadCount: await this.inbox.countUnread(principal.userId) };
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'markAllNotificationsRead',
    summary: 'Mark every unread notification read',
    description: [
      'Returns how many entries changed. Idempotent — a second call returns `updated: 0`, which is the',
      'correct answer rather than an error, and is what a client that retries should see.',
      '',
      'Entries already read keep their original `readAt`. "Mark everything read" must not rewrite the',
      'moment someone actually read a notification.',
    ].join('\n'),
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['updated', 'unreadCount'],
      properties: {
        updated: { type: 'number', description: 'Entries this call marked read.' },
        unreadCount: { type: 'number', description: 'Unread entries remaining.' },
      },
    },
  })
  @ApiAuthedErrorResponses()
  async readAll(@CurrentUser() principal: Principal) {
    const updated = await this.inbox.markAllRead(principal.userId);
    return { updated, unreadCount: await this.inbox.countUnread(principal.userId) };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'markNotificationRead',
    summary: 'Mark one notification read',
    description: [
      '**A notification that is not the caller’s is a 404**, identical to one that does not exist. A',
      '403 would confirm the id is real, which turns this route into an oracle for enumerating other',
      'users’ notifications — the same reasoning as `RIDE_NOT_VISIBLE` (§4.8.4).',
      '',
      'Marking an already-read notification is a 200, not a 409. Two tabs marking the same entry open is',
      'routine rather than a conflict, and it returns the *original* `readAt`: re-reading something does',
      'not un-read it or restamp it.',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'The notification to mark read.' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['id', 'readAt', 'unreadCount'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        readAt: { type: 'string', format: 'date-time', description: 'When it was first marked read.' },
        unreadCount: { type: 'number', description: 'Unread entries remaining for the caller.' },
      },
    },
  })
  @ApiAuthedErrorResponses('NOTIFICATION_NOT_FOUND')
  async markRead(@CurrentUser() principal: Principal, @Param('id') id: string) {
    const result = await this.inbox.markRead(principal.userId, id);
    if (!result) throw new NotificationNotFoundError(id);

    return {
      id,
      readAt: result.readAt.toISOString(),
      unreadCount: await this.inbox.countUnread(principal.userId),
    };
  }
}

function toResponse(row: InAppNotificationRecord): InAppNotificationDto {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    rideId: row.rideId,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}