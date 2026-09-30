-- §4.14.3 — integrity that application code cannot be trusted to enforce.
--
-- Prisma's schema language has no expression for a partial index or a CHECK
-- constraint, so these statements are hand written rather than generated. Prisma
-- introspects them back out and will not try to drop them on the next
-- `migrate dev`.
--
-- Column names are camelCase and therefore quoted: the @@map directives in
-- schema.prisma rename tables only, not columns.

-- 1. "A rider has at most one active ride."
--
--    This is the database-level guarantee behind the product rule, and it is
--    what makes two concurrent POST /rides impossible to both succeed. The
--    application check in request-ride.use-case.ts is a check-then-act read and
--    is therefore a race; this index is the arbiter. When both requests commit,
--    one loses on the unique violation and surfaces as RIDE_ALREADY_ACTIVE
--    rather than as a second ride.
--
--    CANCELLED and COMPLETED are excluded deliberately: a rider may have many
--    finished rides, and constraining the terminal states would make a rider's
--    second historical ride impossible to insert.
CREATE UNIQUE INDEX rides_one_active_per_rider
  ON rides ("riderId")
  WHERE status IN ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS');

-- 2. A ride is ACCEPTED or later iff it has a driver.
--
--    Equivalence, not implication, and that is the point: without the reverse
--    direction this would permit a REQUESTED ride with a driver already attached,
--    which is precisely the corrupt state a lost update produces. Combined with
--    the conditional update in prisma-ride.repository.ts this makes "two drivers
--    accepted this ride" impossible at the storage layer rather than unlikely.
ALTER TABLE rides
  ADD CONSTRAINT rides_driver_status_consistency
  CHECK ((status IN ('ACCEPTED', 'IN_PROGRESS', 'COMPLETED')) = ("driverId" IS NOT NULL));

-- 3. A ride cannot be both completed and cancelled.
--
--    Kept from §4.14.3 verbatim even though the RideStatus enum already makes it
--    unrepresentable. The point is defence in depth: an enum is enforced by the
--    application and the ORM, a CHECK by the engine, and a future migration that
--    relaxes the enum should not silently relax this rule.
ALTER TABLE rides
  ADD CONSTRAINT rides_terminal_exclusive
  CHECK (NOT (status = 'COMPLETED' AND status = 'CANCELLED'));

-- 4. version >= 1.
--
--    §4.5.2c relies on version being a monotonic counter that starts at 1. Zero or
--    negative would make the conditional-update predicate (version = ?) match a row
--    no writer ever intended to touch.
ALTER TABLE rides
  ADD CONSTRAINT rides_version_positive CHECK (version >= 1);
