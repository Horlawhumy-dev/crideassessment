import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '../../rides/domain/ride-policy';

export const CurrentUser = createParamDecorator(
  (field: keyof Principal | undefined, context: ExecutionContext) => {
    const principal = context.switchToHttp().getRequest<{ user: Principal }>().user;
    return field ? principal?.[field] : principal;
  },
);
