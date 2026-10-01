import {
  ACTIVE_STATUSES,
  RIDE_STATUSES,
  RIDE_TRANSITIONS,
  TERMINAL_STATUSES,
  TRANSITION_ACTOR,
  allowedTransitions,
  assertTransition,
  canTransition,
  isActive,
  isTerminal,
  InvalidTransitionError,
  WrongActorError,
  assertSystemExpiry,
  type RideActor,
  type RideStatus,
} from './ride-status';

/** The full 5x5x2 transition matrix, including the cells that must fail. */
describe('ride state machine', () => {
  const ACTORS: readonly RideActor[] = ['RIDER', 'DRIVER', 'SYSTEM'];

  describe('exhaustiveness', () => {
    it('has a transition entry for every status', () => {
      expect(Object.keys(RIDE_TRANSITIONS).sort()).toEqual([...RIDE_STATUSES].sort());
    });

    it('has an actor entry for every status', () => {
      expect(Object.keys(TRANSITION_ACTOR).sort()).toEqual([...RIDE_STATUSES].sort());
    });

    it('never lists an unknown target status', () => {
      for (const from of RIDE_STATUSES) {
        for (const to of RIDE_TRANSITIONS[from]) {
          expect(RIDE_STATUSES).toContain(to);
        }
      }
    });

    it('has no self-transitions', () => {
      for (const from of RIDE_STATUSES) {
        expect(RIDE_TRANSITIONS[from]).not.toContain(from);
      }
    });
  });

  describe('the full matrix', () => {
    // Two independent questions: `canTransition` asks whether the edge exists,
    // `assertTransition` whether this actor may drive it. ACCEPTED -> CANCELLED is legal
    // but rider-forbidden, so the table test below sees it as permitted.
    for (const from of RIDE_STATUSES) {
      for (const to of RIDE_STATUSES) {
        const edgeExists = RIDE_TRANSITIONS[from].includes(to);

        it(`${from} -> ${to}: edge ${edgeExists ? 'exists' : 'is absent'}`, () => {
          expect(canTransition(from, to)).toBe(edgeExists);
          expect(allowedTransitions(from).includes(to)).toBe(edgeExists);
        });

        for (const actor of ACTORS) {
          const permitted = edgeExists && TRANSITION_ACTOR[to].includes(actor);

          it(`${from} -> ${to} by ${actor} is ${permitted ? 'permitted' : 'rejected'}`, () => {
            if (permitted) {
              expect(() => assertTransition(from, to, actor)).not.toThrow();
            } else {
              expect(() => assertTransition(from, to, actor)).toThrow();
            }
          });
        }
      }
    }

    it('rejects a wrong actor with WrongActorError, not InvalidTransitionError', () => {
      // Lets the API return 403 instead of 409: "drivers do that" vs "that is not a thing".
      expect(() => assertTransition('REQUESTED', 'ACCEPTED', 'RIDER')).toThrow(
        WrongActorError,
      );
      expect(() => assertTransition('ACCEPTED', 'IN_PROGRESS', 'DRIVER')).not.toThrow();
    });

    it('lets the assigned driver cancel, and keeps SYSTEM out of it entirely', () => {
      expect(() => assertTransition('ACCEPTED', 'CANCELLED', 'DRIVER')).not.toThrow();
      expect(() => assertTransition('IN_PROGRESS', 'CANCELLED', 'DRIVER')).not.toThrow();

      // The sweep must not reach a ride with a driver; SYSTEM is refused for CANCELLED.
      expect(() => assertTransition('ACCEPTED', 'CANCELLED', 'SYSTEM')).toThrow(
        WrongActorError,
      );
      expect(() => assertTransition('REQUESTED', 'CANCELLED', 'SYSTEM')).toThrow(
        WrongActorError,
      );
      expect(() => assertSystemExpiry('REQUESTED', 'CANCELLED')).not.toThrow();
    });
  });

  describe('the documented rules', () => {
    it('models "a driver may drop the trip" as an edge, not as an absence of one', () => {
      // The graph says the move is possible; ride-policy.ts says who may make it.
      expect(canTransition('ACCEPTED', 'CANCELLED')).toBe(true);
      expect(canTransition('IN_PROGRESS', 'CANCELLED')).toBe(true);
      expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
      expect(canTransition('CANCELLED', 'CANCELLED')).toBe(false);
    });

    it('does not allow skipping ACCEPTED', () => {
      expect(canTransition('REQUESTED', 'IN_PROGRESS')).toBe(false);
    });

    it('does not allow skipping IN_PROGRESS', () => {
      expect(canTransition('ACCEPTED', 'COMPLETED')).toBe(false);
    });

    it('allows a rider to cancel while still unassigned', () => {
      expect(canTransition('REQUESTED', 'CANCELLED')).toBe(true);
    });

    it('treats both terminal states as terminal', () => {
      for (const status of TERMINAL_STATUSES) {
        expect(isTerminal(status)).toBe(true);
        expect(allowedTransitions(status)).toHaveLength(0);
      }
    });

    it('treats REQUESTED, ACCEPTED and IN_PROGRESS as blocking a new request', () => {
      for (const status of RIDE_STATUSES) {
        expect(isActive(status)).toBe(ACTIVE_STATUSES.includes(status));
      }
    });

    it('lets exactly one role drive each status, except CANCELLED', () => {
      // CANCELLED is the only two-actor target; every other has one owner, which keeps a
      // wrong actor a 403 rather than an ambiguous 409.
      for (const status of RIDE_STATUSES) {
        const actors = TRANSITION_ACTOR[status];
        if (status === 'CANCELLED') {
          expect([...actors].sort()).toEqual(['DRIVER', 'RIDER']);
        } else {
          expect(actors).toHaveLength(1);
        }
      }

      expect([...TRANSITION_ACTOR.ACCEPTED]).toEqual(['DRIVER']);
      expect([...TRANSITION_ACTOR.IN_PROGRESS]).toEqual(['DRIVER']);
      expect([...TRANSITION_ACTOR.COMPLETED]).toEqual(['DRIVER']);
      // REQUESTED is the initial state and is not entered by a transition.
      expect([...TRANSITION_ACTOR.REQUESTED]).toEqual(['RIDER']);
    });

    it('never leaves a reachable status without a required actor', () => {
      for (const status of RIDE_STATUSES) {
        const reachable = RIDE_STATUSES.some((f) => RIDE_TRANSITIONS[f].includes(status));
        if (reachable) expect(TRANSITION_ACTOR[status].length).toBeGreaterThan(0);
      }
    });
  });

  describe('error types', () => {
    it('reports an illegal edge with both statuses attached', () => {
      try {
        assertTransition('COMPLETED', 'REQUESTED', 'RIDER');
        throw new Error('should not reach');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidTransitionError);
        expect((err as InvalidTransitionError).from).toBe('COMPLETED');
        expect((err as InvalidTransitionError).to).toBe('REQUESTED');
      }
    });

    it('distinguishes a legal edge driven by the wrong actor', () => {
      // An authorization failure, not a modelling failure: different client messaging.
      try {
        assertTransition('REQUESTED', 'ACCEPTED', 'RIDER');
        throw new Error('should not reach');
      } catch (err) {
        expect(err).toBeInstanceOf(WrongActorError);
        expect(canTransition('REQUESTED', 'ACCEPTED')).toBe(true);
      }
    });
  });

  describe('assertSystemExpiry', () => {
    it('allows the one move expiry is for', () => {
      expect(() => assertSystemExpiry('REQUESTED', 'CANCELLED')).not.toThrow();
    });

    it('refuses to cancel a ride that already has a driver', () => {
      // A late sweep or slow Redis lock must not yank a trip from a rider mid-journey.
      for (const status of ['ACCEPTED', 'IN_PROGRESS'] as const) {
        expect(() => assertSystemExpiry(status, 'CANCELLED')).toThrow(InvalidTransitionError);
      }
    });

    it('refuses to touch a terminal ride', () => {
      for (const status of ['COMPLETED', 'CANCELLED'] as const) {
        expect(() => assertSystemExpiry(status, 'CANCELLED')).toThrow(InvalidTransitionError);
      }
    });

    it('cannot be used to reach any non-cancel state', () => {
      // A narrow allowlist: the only `to` expiry may ever drive is CANCELLED.
      for (const to of RIDE_STATUSES.filter((s) => s !== 'CANCELLED')) {
        expect(() => assertSystemExpiry('REQUESTED', to)).toThrow(InvalidTransitionError);
      }
    });

    it('leaves the principal path unable to act as a machine', () => {
      // The HTTP guard must keep rejecting SYSTEM, or an expiry job could skip the
      // visibility check on the request path.
      expect(() => assertTransition('REQUESTED', 'ACCEPTED', 'SYSTEM')).toThrow(WrongActorError);
      expect(() => assertTransition('REQUESTED', 'CANCELLED', 'SYSTEM')).toThrow(WrongActorError);
    });
  });
});

export type { RideStatus };
