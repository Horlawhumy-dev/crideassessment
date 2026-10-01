import './instrumentation';

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WorkerModule } from './worker.module';
import { APP_CONFIG, type AppConfig } from './config/configuration';
import { ConfigService } from '@nestjs/config';
import { runsWorker } from './config/app-role';
import { LoggerService } from './platform/otel/logger';

/** Created as a NestExpressApplication with an unused HTTP server purely so BullMQ's ioredis
 * connections and the outbox relay's timer have a Nest lifecycle to attach to. Without an
 * application context `onApplicationBootstrap` and `onModuleDestroy` never fire: the process
 * would start, claim nothing, and never shut down cleanly, leaving DEAD rows on every deploy. */
async function worker(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(WorkerModule, {
    bufferLogs: true,
  });
  const config = app.get(ConfigService).get<AppConfig>(APP_CONFIG)!;

  // Same reason as the API process: the relay and the queue consumers are the loudest
  // things here, and their logs have to be joinable to traces.
  app.useLogger(app.get(LoggerService));

  if (!runsWorker(config.APP_ROLE)) {
    throw new Error(`APP_ROLE=${config.APP_ROLE} does not run the worker.`);
  }

  app.enableShutdownHooks();
  await app.init();
  new Logger('Worker').log(`worker started role=${config.APP_ROLE}`);
}

void worker();
