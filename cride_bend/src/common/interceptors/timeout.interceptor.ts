import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { TimeoutError, throwError, type Observable } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { DomainError } from '../errors/domain-error';

/** A hard cap, so a slow dependency becomes a coded 500 rather than a hung socket. */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly config: ConfigService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { REQUEST_TIMEOUT_MS } = this.config.get<AppConfig>(APP_CONFIG)!;
    return next.handle().pipe(
      timeout(REQUEST_TIMEOUT_MS),
      catchError((err) =>
        throwError(() =>
          err instanceof TimeoutError
            ? new DomainError('INTERNAL_ERROR', 'The request timed out.')
            : err,
        ),
      ),
    );
  }
}
