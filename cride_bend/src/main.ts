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

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService).get<AppConfig>(APP_CONFIG)!;

  // Credentials must be allowed for the httpOnly session cookie to be sent (§4.12.4).
  // The wildcard is rejected at boot by env.schema.ts in production.
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });

  app.use(cookieParser());

  // Must be installed before listen(): the adapter has to exist when the io server
  // is constructed, not after. Without it, rooms are per-replica and a ride event
  // reaches only the clients attached to the replica that published it.
  app.useWebSocketAdapter(new RedisIoAdapter(app, app.get(RedisClient)));

  // No global ValidationPipe. Every route declares its own ZodValidationPipe, and
  // a global class-validator pipe would be a second, silently-unused validation
  // path: `whitelist` strips unknown keys on the *validated* object while Zod's
  // default strip behaviour decides what actually reaches the use-case, so the two
  // would disagree about which properties exist. One validator per route, and it
  // is the one whose schema is the source of truth for that route.
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
