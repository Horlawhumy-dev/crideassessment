import { SetMetadata } from '@nestjs/common';

/** Marks a provider as producer-only, so it is not instantiated in worker role. */
export const PRODUCER_ONLY = 'producer-only';
export const ProducerOnly = () => SetMetadata(PRODUCER_ONLY, true);
