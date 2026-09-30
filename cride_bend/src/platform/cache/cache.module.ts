import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { RedisClient } from './redis.client';

@Global()
@Module({
  providers: [RedisClient, CacheService],
  exports: [RedisClient, CacheService],
})
export class CacheModule {}
