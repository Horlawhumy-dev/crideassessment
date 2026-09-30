import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Registered as APP_GUARD, so authentication is default-deny: a new route is protected
 * by construction and exposing one takes a deliberate @Public(). Composition only —
 * role and ownership rules live in rides/domain/ride-policy.ts.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // getAllAndOverride walks handler-then-class, so @Public() on one handler beats a
    // class-level one. Both are read because gateways pass the event as getHandler().
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    return super.canActivate(context);
  }

  /**
   * MUST throw: `AuthGuard.canActivate` returns true unconditionally once the passport
   * callback has run and nothing downstream re-checks, so returning the user here would
   * make every authenticated route public.
   */
  handleRequest<TUser>(err: unknown, user: TUser, info: unknown): TUser {
    if (err || !user) {
      throw err instanceof Error ? err : new UnauthorizedException();
    }
    return user;
  }
}
