import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Response } from 'express';
import { CORRELATION_HEADER, resolveCorrelationId } from '../../kernel/correlation-id';

/**
 * Runs first in the chain, so downstream logs, spans, events, outbox rows and jobs
 * all join on one identifier.
 */
@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const req = http.getRequest<{ headers: Record<string, unknown> }>();
    const correlationId = resolveCorrelationId(req?.headers?.[CORRELATION_HEADER]);

    (req as Record<string, unknown>).correlationId = correlationId;
    const res = http.getResponse<Response>();
    if (typeof res?.setHeader === 'function') {
      res.setHeader(CORRELATION_HEADER, correlationId);
    }

    return next.handle();
  }
}
