import './instrumentation';

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/configuration';
import { RedisClient } from './platform/cache/redis.client';
import { RedisIoAdapter } from './platform/realtime/redis-io.adapter';
import { servesHttp } from './config/app-role';
import { buildOpenApiDocument } from './common/openapi/build-openapi-document';
import { LoggerService } from './platform/otel/logger';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService).get<AppConfig>(APP_CONFIG)!;

  // Without this the structured logger is only reached by the interceptors, so framework
  // and application logs arrive in two formats on the same stream and half cannot be joined
  // to a trace. `bufferLogs: true` defers emissions until here, so nothing is lost.
  app.useLogger(app.get(LoggerService));

  // Credentials must be allowed for the httpOnly session cookie to be sent.
  // The wildcard is rejected at boot by env.schema.ts in production.
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });

  app.use(cookieParser());

  // MUST be installed before listen(): the adapter has to exist when the io server is
  // constructed and cannot be set afterwards. Without it rooms are per-replica and a ride
  // event reaches only the clients on the replica that published it.
  app.useWebSocketAdapter(new RedisIoAdapter(app, app.get(RedisClient)));

  // No global ValidationPipe. Every route declares its own ZodValidationPipe, and a global
  // class-validator pipe would be a second, silently-unused path that disagrees with Zod
  // about which properties exist. One validator per route, and its schema is the source
  // of truth for that route.
  app.enableShutdownHooks();

  SwaggerModule.setup('docs', app, buildOpenApiDocument(app));

  if (!servesHttp(config.APP_ROLE)) {
    throw new Error(`APP_ROLE=${config.APP_ROLE} does not serve HTTP; start the worker instead.`);
  }

  // 0.0.0.0, not localhost: binding localhost is a container that answers its own
  // health check and is unreachable from the host.
  await app.listen(config.PORT, '0.0.0.0');
  new Logger('Bootstrap').log(`api listening on :${config.PORT} role=${config.APP_ROLE}`);
}

void main();
