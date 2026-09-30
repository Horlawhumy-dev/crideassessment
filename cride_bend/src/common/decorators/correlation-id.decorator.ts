import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { resolveCorrelationId } from '../../kernel/correlation-id';

export const CorrelationId = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    return resolveCorrelationId(req?.headers?.['x-request-id']);
  },
);
