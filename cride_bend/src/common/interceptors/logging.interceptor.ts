import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { LoggerService } from '../../platform/otel/logger';

/**
 * Allowlist rather than a redaction denylist: a denylist silently starts leaking
 * as the code grows new fields.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: LoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{ method: string; route?: { path?: string }; url: string; user?: { userId: string; role: string }; correlationId?: string }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.logger.info('http.request', {
          method: req.method,
          // Route template, never the raw URL: the raw URL can carry a resource id.
          route: req.route?.path ?? req.url,
          status: http.getResponse<{ statusCode: number }>().statusCode,
          durationMs: Date.now() - startedAt,
          userId: req.user?.userId,
          role: req.user?.role,
          correlationId: req.correlationId,
        }),
        error: (err: unknown) => this.logger.error('http.request.failed', {
          method: req.method,
          route: req.route?.path ?? req.url,
          durationMs: Date.now() - startedAt,
          userId: req.user?.userId,
          correlationId: req.correlationId,
          errorCode: (err as { code?: string })?.code,
        }),
      }),
    );
  }
}
