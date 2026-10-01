import { z } from 'zod';

/** The only place environment variables are read; validated once at boot. */
const csv = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
  .pipe(z.array(z.string()));

/**
 * NOT z.coerce.boolean(): `Boolean("false")` is true, so coercion inverts the flag —
 * `FCM_ENABLED=false` would enable Firebase, then fail the credential check.
 */
const bool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v, ctx) => {
      if (typeof v === 'boolean') return v;
      const normalised = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'off', ''].includes(normalised)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected a boolean (true/false), received "${v}"`,
      });
      return z.NEVER;
    });

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required.'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required.'),

  JWT_SECRET: z.string().min(16).default('dev-only-insecure-secret'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-only-insecure-refresh'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  THROTTLE_TTL_SECONDS: z.coerce.number().int().default(60),
  THROTTLE_LIMIT: z.coerce.number().int().default(100),
  AUTH_THROTTLE_LIMIT: z.coerce.number().int().default(5),

  RIDE_CACHE_TTL_SECONDS: z.coerce.number().int().default(30),
  RIDE_OFFER_TTL_MINUTES: z.coerce.number().int().default(10),
  /**
   * Tunable both ways: an operator may want it tighter than the offer window, and
   * test/fixtures/env-e2e.ts pushes it out of range so no sweep cancels stale rides.
   */
  RIDE_EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  LOCATION_TTL_SECONDS: z.coerce.number().int().default(90),
  LOCATION_MIN_INTERVAL_MS: z.coerce.number().int().default(3000),
  LOCATION_MAX_JUMP_METRES: z.coerce.number().int().default(2000),

  FCM_ENABLED: bool(false),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  OTEL_ENABLED: bool(false),
  OTEL_SERVICE_NAME: z.string().default('cride-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  DRIVER_MATCHING_ENABLED: bool(false),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().default(8000),

  /**
   * Minor units (kobo, pence), never floats: `Money` is a bigint of minor units end to
   * end. Defaults are the NGN table; FARE_CURRENCY travels with every fare.
   */
  FARE_CURRENCY: z.string().length(3).default('NGN'),
  FARE_BASE_MINOR: z.coerce.number().int().min(0).default(1_000),
  FARE_PER_KM_MINOR: z.coerce.number().int().min(0).default(600),
  FARE_PER_MINUTE_MINOR: z.coerce.number().int().min(0).default(100),
  FARE_MINIMUM_MINOR: z.coerce.number().int().min(0).default(1_500),
});

export type RawConfig = z.infer<typeof baseSchema>;

export const configSchema = baseSchema
  .superRefine((cfg, ctx) => {
    const firebaseKeys = [
      cfg.FIREBASE_PROJECT_ID,
      cfg.FIREBASE_CLIENT_EMAIL,
      cfg.FIREBASE_PRIVATE_KEY,
    ];
    const provided = firebaseKeys.filter((v) => v !== undefined && v !== '');

    if (provided.length > 0 && provided.length < firebaseKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Firebase configuration is all-or-none. Provide FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY together, or none of them.',
        path: ['FIREBASE_PROJECT_ID'],
      });
    }

    if (cfg.FCM_ENABLED && provided.length !== firebaseKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'FCM_ENABLED=true requires complete Firebase credentials.',
        path: ['FCM_ENABLED'],
      });
    }

    if (cfg.OTEL_ENABLED && !cfg.OTEL_EXPORTER_OTLP_ENDPOINT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OTEL_ENABLED=true requires OTEL_EXPORTER_OTLP_ENDPOINT.',
        path: ['OTEL_ENABLED'],
      });
    }

    // The example values are refused in production: a leaked secret fails at boot.
    if (cfg.NODE_ENV === 'production') {
      if (cfg.JWT_SECRET.startsWith('dev-only')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'JWT_SECRET still holds its example value.',
          path: ['JWT_SECRET'],
        });
      }
      if (cfg.CORS_ORIGIN === '*') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'CORS_ORIGIN cannot be "*" in production: the session is a cookie.',
          path: ['CORS_ORIGIN'],
        });
      }
    }
  })
  // The field's own csv transform, so "comma-separated" is defined exactly once.
  .transform((cfg) => ({ ...cfg, corsOrigins: csv.parse(cfg.CORS_ORIGIN) }));

export type AppConfig = z.infer<typeof configSchema>;

/** Frozen so no consumer can mutate config at runtime; a bad value throws at boot. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(source);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }

  return Object.freeze(parsed.data);
}
