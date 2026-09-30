-- A driver may now cancel the ride they hold (src/rides/domain/ride-policy.ts,
-- `assertCanCancel`). This migration exists because of what that change implies
-- about the row it writes.
--
-- `rides_driver_status_consistency` (0002) is a single equivalence:
--
--   (status IN ('ACCEPTED','IN_PROGRESS','COMPLETED')) = ("driverId" IS NOT NULL)
--
-- A driver cancelling an ACCEPTED ride moves the row to CANCELLED while
-- `driverId` still names them — `transitionWithVersion` deliberately does not
-- null it — which evaluates FALSE = TRUE and violates the constraint. Left alone,
-- the very first driver cancellation fails with a raw Prisma error surfaced as a
-- 500: a domain rule passing every unit test and a CHECK constraint disagreeing
-- at the storage layer.
--
-- Two ways out, and the choice is the point:
--
--   a) Null `driverId` on cancel. Rejected. It makes the row lie — the ride then
--      claims nobody was driving it, so the trip history stops showing who the
--      driver was. On a platform where "which driver was on my trip, and did they
--      cancel it?" is the first question asked after something goes wrong,
--      destroying that at write time to satisfy a constraint is the wrong trade.
--      `cancelledBy` records who *acted*; it does not record who was *assigned*,
--      and a driver abandoning a trip is a materially different event from a ride
--      nobody ever accepted. The two must not collapse into the same row shape.
--
--   b) Split the equivalence into its two implications and relax only the half
--      that cancellation actually needs. Taken.
--
-- What survives, and is the half that was doing the real work:
--
--   Forward: a committed ride HAS a driver.
--     status IN (ACCEPTED, IN_PROGRESS, COMPLETED) -> driverId IS NOT NULL
--
--   Reverse: a ride with a driver is committed — never REQUESTED.
--     driverId IS NOT NULL -> status <> 'REQUESTED'
--
-- Together those still make "two drivers accepted this ride" and "a REQUESTED
-- ride already has a driver on it" impossible at the storage layer, which is what
-- 0002 was defending against. Only CANCELLED is freed, because it is the one
-- status that legitimately occurs both with a driver (they cancelled) and
-- without one (the rider cancelled, or the expiry sweep found nobody).
--
-- Note this constraint was never the thing preventing those rows. A SYSTEM may
-- only cancel a REQUESTED ride (`assertSystemExpiry`) and a rider likewise, so
-- CANCELLED-without-a-driver was simply unreachable; a driver who can cancel is
-- the first path that reaches CANCELLED-with-one. Application rules are exactly
-- what a storage constraint should not have been standing in for.

ALTER TABLE rides
  DROP CONSTRAINT rides_driver_status_consistency;

ALTER TABLE rides
  ADD CONSTRAINT rides_driver_status_consistency
  CHECK (
    -- Forward: a committed ride has a driver.
    (status NOT IN ('ACCEPTED', 'IN_PROGRESS', 'COMPLETED') OR "driverId" IS NOT NULL)
    -- Reverse: a ride with a driver is committed. CANCELLED is admitted here and
    -- nowhere else; REQUESTED is what a lost update would leave behind.
    AND ("driverId" IS NULL OR status <> 'REQUESTED')
  );