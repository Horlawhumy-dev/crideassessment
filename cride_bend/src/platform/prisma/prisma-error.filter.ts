import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { DomainError } from '../../common/errors/domain-error';
import { ERROR_REGISTRY } from '../../common/errors/error-codes';

/**
 * Translates Prisma's wire-level failures into the domain error contract. The system's most
 * important integrity rule is enforced by the *database*: the partial unique index
 * `rides_one_active_per_rider` is the arbiter of "a rider has at most one active ride", so the
 * check-then-act read in request-ride.use-case.ts is a race and the loser is decided by
 * Postgres. Untranslated, that loser became a 500 contradicting the controller's own documented
 * 409 `RIDER_ALREADY_HAS_ACTIVE_RIDE`. Anything not translated here still reaches
 * `AllExceptionsFilter`, keeping its "log the cause, answer generically" behaviour.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientUnknownRequestError, Prisma.PrismaClientRustPanicError)
export class PrismaErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<{ correlationId?: string; url?: string }>();
    const correlationId = req.correlationId;
    const timestamp = new Date().toISOString();

    const translated = this.translate(exception);

    if (translated) {
      res.status(translated.status).json({
        error: {
          code: translated.code,
          message: translated.message,
          ...(translated.details ? { details: translated.details } : {}),
          correlationId,
          timestamp,
        },
      });
      return;
    }

    // Unrecognised Prisma failure: a real fault, not a domain outcome. Log the cause,
    // answer with the generic 500.
    this.logger.error('prisma.unhandled', {
      correlationId,
      path: req?.url,
      error: exception instanceof Error ? exception.message : String(exception),
    });

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { ...ERROR_REGISTRY.INTERNAL_ERROR, correlationId, timestamp },
    });
  }

  private translate(exception: unknown): DomainError | null {
    if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) return null;

    switch (exception.code) {
      case 'P2002': {
        const target = uniqueTarget(exception);

        if (target.includes('rides_one_active_per_rider')) {
          // Lost the race against a concurrent request-ride: 409 with the code the
          // controller documents, not a 500.
          return new DomainError(
            'RIDER_ALREADY_HAS_ACTIVE_RIDE',
            undefined,
            { constraint: target },
          );
        }

        if (target.includes('idempotency_keys')) {
          // @@unique([key, userId]) — the same key replayed with a different body. The store
          // is written by the idempotency path itself, so this is the database saying what
          // IdempotencyKeyReusedError says in the slow path.
          return new DomainError('IDEMPOTENCY_KEY_REUSED', undefined, { constraint: target });
        }

        if (target.includes('users') && target.includes('email')) {
          // auth.service.ts answers "email already taken" as INVALID_CREDENTIALS on purpose,
          // so registration is not an account-existence oracle. Its check-then-act has the
          // same race as the ride index, so the answer stays identical either way.
          return new DomainError('INVALID_CREDENTIALS');
        }

        return null;
      }

      case 'P2025':
        // A conditional update matched nothing: the record is gone or no longer matches.
        // Callers that care use their own 0-row branch.
        return new DomainError('RIDE_VERSION_CONFLICT');

      case 'P2034':
        // Write conflict or deadlock. Retryable by nature, so it must not read as
        // "your input was wrong".
        return new DomainError('DATABASE_UNAVAILABLE');

      case 'P1001':
      case 'P1002':
        // Cannot reach the database / connection pool exhausted.
        return new DomainError('DATABASE_UNAVAILABLE');

      default:
        return null;
    }
  }
}

/** `meta.target` is a string for a raw index constraint and an array for a declared
 * `@@unique`, so both shapes have to be flattened before matching. */
function uniqueTarget(exception: Prisma.PrismaClientKnownRequestError): string {
  const target = (exception.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.join(',');
  return typeof target === 'string' ? target : '';
}
