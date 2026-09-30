import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, type AllowedRole } from '../decorators/roles.decorator';
import { AuthError, ForbiddenRoleError } from '../errors/domain-error';
import type { Principal } from '../../rides/domain/ride-policy';

/** The data-free half of authorization; ride ownership is enforced in ride-policy.ts. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AllowedRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const principal = context.switchToHttp().getRequest<{ user?: Principal }>().user;
    if (!principal) throw new AuthError('MISSING_TOKEN');
    if (!required.includes(principal.role)) throw new ForbiddenRoleError(principal.role);

    return true;
  }
}
