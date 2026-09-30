import { Global, Module } from '@nestjs/common';
import { LoggerService } from './logger';
import { MetricsService } from './metrics';
import { TracingService } from './tracing';

@Global()
@Module({
  providers: [LoggerService, MetricsService, TracingService],
  exports: [LoggerService, MetricsService, TracingService],
})
export class TelemetryModule {}
