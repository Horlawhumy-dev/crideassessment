import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Replaces the deprecated `package.json#prisma` block. The seed command lives
 * here rather than in package.json so it is declared in one place and so
 * `prisma db seed` keeps working after the Prisma 7 migration.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
