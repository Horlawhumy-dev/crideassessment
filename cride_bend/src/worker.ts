import './instrumentation';

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WorkerModule } from './worker.module';
import { APP_CONFIG, type AppConfig } from './config/configuration';
import { ConfigService } from '@nestjs/config';
import { runsWorker } from './config/app-role';

/**
 * §3.2 — the worker entrypoint.
 *
 * Created as a NestExpressApplication with an unused HTTP server purely so
 * BullMQ's underlying ioredis connections and the outbox relay's timer get a
 * Nest lifecycle to attach to. Without an application context, OnApplicationBootstrap
 * and OnModuleDestroy never fire, and the process would start, claim nothing, and
 * never shut down cleanly — which is exactly the failure mode that leaves DEAD
 * rows behind a rolling deploy.
 */
async function worker(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(WorkerModule, {
    bufferLogs: false,
  });
  const config = app.get(ConfigService).get<AppConfig>(APP_CONFIG)!;

  if (!runsWorker(config.APP_ROLE)) {
    throw new Error(`APP_ROLE=${config.APP_ROLE} does not run the worker.`);
  }

  app.enableShutdownHooks();
  await app.init();
  new Logger('Worker').log(`worker started role=${config.APP_ROLE}`);
}

void worker();
