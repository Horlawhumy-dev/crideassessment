import { registerAs } from '@nestjs/config';
import { loadConfig, type AppConfig } from './env.schema';

/** Registered via ConfigModule.forRoot({ load: [configuration] }) so no other file reads process.env. */
export const configuration = registerAs('app', (): AppConfig => loadConfig());

export const APP_CONFIG = 'app';

export type { AppConfig };
