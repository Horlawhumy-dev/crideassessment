-- §4.7 — the in-app inbox, alongside the push delivery audit.
--
-- Purely additive: a new enum, a new table and two foreign keys. Nothing existing
-- is altered, so this applies to a populated database without a data migration
-- and without a lock on a table the ride write path is using.
--
-- Generated with `prisma migrate diff` rather than hand written, then applied
-- with `migrate deploy`. `migrate dev` wanted to reset the database instead,
-- because migration 0002 has been edited since it was applied — the drift is in
-- that file's contents, not in this schema, so dropping and rebuilding a
-- database that already matches `schema.prisma` would destroy live data to fix
-- nothing. The diff between the running database and the schema was exactly the
-- statements below and nothing else, which is what made the reset unnecessary.
--
-- Column names are camelCase and therefore quoted: the @@map directive in
-- schema.prisma renames the table only, not its columns.

-- CreateEnum
CREATE TYPE "InAppNotificationKind" AS ENUM ('RIDE_REQUESTED', 'RIDE_ACCEPTED', 'RIDE_IN_PROGRESS', 'RIDE_COMPLETED', 'RIDE_CANCELLED');

-- CreateTable
CREATE TABLE "in_app_notifications" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "kind" "InAppNotificationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "in_app_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "in_app_notifications_dedupeKey_key" ON "in_app_notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "in_app_notifications_userId_readAt_createdAt_idx" ON "in_app_notifications"("userId", "readAt", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "in_app_notifications" ADD CONSTRAINT "in_app_notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_app_notifications" ADD CONSTRAINT "in_app_notifications_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "rides"("id") ON DELETE CASCADE ON UPDATE CASCADE;