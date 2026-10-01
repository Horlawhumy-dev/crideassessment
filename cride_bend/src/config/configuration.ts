import { registerAs } from '@nestjs/config';
import { loadConfig, type AppConfig } from './env.schema';

/** Loaded by ConfigModule.forRoot({ load: [configuration] }); no other file reads process.env. */
export const configuration = registerAs('app', (): AppConfig => loadConfig());

export const APP_CONFIG = 'app';

export type { AppConfig };
