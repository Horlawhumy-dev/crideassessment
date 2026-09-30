/**
 * §46 — seed data, so a reviewer can run the demo without creating accounts.
 *
 * The password is deliberately >= 10 characters: the register/login schema
 * enforces a minimum of 10, and a shorter seed password produces a session that
 * cannot be reproduced through the API and looks like an auth bug.
 *
 * Run with `npm run db:seed` (or `npx tsx prisma/seed.ts`).
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const PASSWORD = 'cride-demo-2026';

const RIDER = {
  email: 'rider@cride.ng',
  displayName: 'Amara Okafor',
  role: 'RIDER' as const,
  phone: '+2348030000001',
};

const DRIVERS = [
  { email: 'driver1@cride.ng', displayName: 'Liam Chen', role: 'DRIVER' as const, phone: '+2348030000002' },
  { email: 'driver2@cride.ng', displayName: 'Priya Shah', role: 'DRIVER' as const, phone: '+2348030000003' },
  { email: 'driver3@cride.ng', displayName: 'Marcus Green', role: 'DRIVER' as const, phone: '+2348030000004' },
];

async function main(): Promise<void> {
  const rounds = Number(process.env.BCRYPT_ROUNDS ?? 12);
  const passwordHash = await bcrypt.hash(PASSWORD, rounds);

  const rider = await prisma.user.upsert({
    where: { email: RIDER.email },
    create: { ...RIDER, passwordHash, isAvailable: false },
    update: { displayName: RIDER.displayName, phone: RIDER.phone },
  });

  for (const driver of DRIVERS) {
    await prisma.user.upsert({
      where: { email: driver.email },
      create: { ...driver, passwordHash, isAvailable: true, lastSeenAt: new Date() },
      update: { displayName: driver.displayName, phone: driver.phone },
    });
  }

  // Readable output: the demo depends on these credentials, and guessing an email
  // is the difference between a 30-second and a 5-minute first run.
  process.stdout.write(
    [
      '',
      '  Seeded. Sign in with any of these and the password below.',
      '',
      `    password   ${PASSWORD}`,
      '',
      `    rider      ${RIDER.email}   (${rider.displayName})`,
      ...DRIVERS.map((d) => `    driver     ${d.email}   (${d.displayName})`),
      '',
      '  Drivers are seeded available, so they receive ride offers immediately.',
      '',
    ].join('\n'),
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
