import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../errors/domain-error';
import { ERROR_REGISTRY, isErrorCode } from '../errors/error-codes';

/**
 * The single place an exception becomes an HTTP response. A DomainError maps to its
 * registered status and is safe to serialise; anything else is logged with its cause
 * and answered with a generic INTERNAL_ERROR, so driver text never reaches a client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<{ correlationId?: string; url?: string }>();
    const correlationId = req.correlationId;
    const timestamp = new Date().toISOString();

    if (exception instanceof DomainError) {
      res.status(exception.status).json({
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details ? { details: exception.details } : {}),
          correlationId,
          timestamp,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json({
        error: {
          code: status === 429 ? 'RATE_LIMITED' : `HTTP_${status}`,
          message: typeof body === 'string' ? body : (body as { message?: string })?.message ?? 'Request failed.',
          correlationId,
          timestamp,
        },
      });
      return;
    }

    this.logger.error('unhandled.exception', {
      correlationId,
      path: req?.url,
      error: exception instanceof Error ? exception.message : String(exception),
      stack: exception instanceof Error ? exception.stack : undefined,
    });

    res.status(500).json({
      error: {
        ...ERROR_REGISTRY.INTERNAL_ERROR,
        correlationId,
        timestamp,
      },
    });
  }
}

export { isErrorCode };
