import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/** Paths whose lease the current fiber already holds. */
const HeldWorkspaceLeases = Context.Reference<ReadonlySet<string>>(
  "t3/workspace/HeldWorkspaceLeases",
  { defaultValue: () => new Set() },
);

/**
 * Coordinates checkout removal and startup across threads using the same
 * resolved cwd. The holder may take the lease again, so removal can run a
 * project script in a terminal in the checkout it is about to remove.
 */
export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const held = yield* HeldWorkspaceLeases;
    if (held.has(cwd)) return yield* effect;
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return yield* lease.semaphore
      .withPermit(effect.pipe(Effect.provideService(HeldWorkspaceLeases, new Set([...held, cwd]))))
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lease.users--;
            if (lease.users === 0) leases.delete(cwd);
          }),
        ),
      );
  });
