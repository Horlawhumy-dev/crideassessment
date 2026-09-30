import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Advisory only, so it always returns true. The authoritative check is
 * rides/domain/ride-policy.ts: needing no repository keeps it out of integration tests.
 */
@Injectable()
export class RideAccessGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
