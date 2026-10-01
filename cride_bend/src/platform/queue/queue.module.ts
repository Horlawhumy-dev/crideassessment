import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { ProducerOnly } from './producer-only.decorator';
import { QueueProducer } from './producer';
import { ALL_QUEUES } from './queues';

/** Producers are registered in both roles so either process can enqueue. Consumers live in
 * notifications/, which is what lets the API run with the worker scaled to zero. */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { REDIS_URL } = config.get<AppConfig>(APP_CONFIG)!;
        return {
          connection: { url: REDIS_URL },
          defaultJobOptions: { backoff: { type: 'exponential', delay: 2_000 } },
        };
      },
    }),
    ...ALL_QUEUES.map((name) => BullModule.registerQueue({ name })),
  ],
  providers: [QueueProducer],
  exports: [BullModule, QueueProducer],
})
export class QueueModule {}

export { ProducerOnly };
