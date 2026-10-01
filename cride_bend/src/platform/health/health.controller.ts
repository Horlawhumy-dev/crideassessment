import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { HealthResponseDto } from '../../common/openapi/api-schemas';

interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  uptimeSeconds: number;
  checks: Record<string, 'up' | 'down' | 'degraded'>;
}

/** Postgres is a hard dependency; Redis reports 'degraded' rather than failing, because a
 * health check that failed on a degraded cache would take the service out of rotation for a
 * non-existent problem. */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  @ApiOperation({
    operationId: 'health',
    summary: 'Liveness and dependency state',
    description: [
      'Unauthenticated and unthrottled, because a probe that can be rate-limited or needs a token is',
      'a probe that will eventually report a false outage.',
      '',
      'Returns 200 while Postgres is reachable. Redis reports `degraded` rather than failing the',
      'check, because every endpoint still serves correct data from Postgres without it (§9 P1). Only',
      '`database: down` produces `status: "down"`.',
      '',
      'Suitable as a Kubernetes liveness probe and as a readiness signal for traffic draining.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: HealthResponseDto,
    description: 'Dependency state. `status` is `down` only when Postgres is unreachable.',
  })
  async check(): Promise<HealthReport> {
    const [database, cacheUp] = await Promise.all([
      this.prisma.isHealthy(),
      Promise.resolve(!this.cache.degraded),
    ]);

    const checks: HealthReport['checks'] = {
      database: database ? 'up' : 'down',
      cache: cacheUp ? 'up' : 'degraded',
    };

    return {
      status: database ? (cacheUp ? 'ok' : 'degraded') : 'down',
      uptimeSeconds: Math.round(process.uptime()),
      checks,
    };
  }
}
