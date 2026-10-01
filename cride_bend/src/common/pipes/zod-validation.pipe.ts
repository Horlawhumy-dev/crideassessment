import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { DomainError } from '../errors/domain-error';

/**
 * Applied per route, not globally, so each handler owns its schema. It runs before
 * auth: a malformed body is a 400 whether or not the token was valid.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  /**
   * Input type is `unknown`, not `T`: a bare ZodType<T> demands input and output types
   * match, which rules out a string-to-array transform such as a comma-separated `status`.
   */
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new DomainError('MISSING_FIELD', 'Request validation failed.', {
        issues: result.error.issues.map((i: ZodError['issues'][number]) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    return result.data;
  }
}
