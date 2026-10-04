import { Context, Effect, Layer, Semaphore } from "effect";
import type { Option } from "effect";
import { canonicalizeWorktreePath, resolveGitWorktreeRoot } from "./worktreePaths.ts";

/**
 * Process-local checkout coordination. Callers hold a reservation only around
 * logical filesystem operations, never while waiting on the orchestration queue.
 * Turn activity lives in the read model; completion exclusions bridge ingestion
 * to the checkpoint worker without holding a mutex across either worker.
 */
export class CheckoutCoordinator extends Context.Service<
  CheckoutCoordinator,
  {
    readonly withCheckout: <A, E, R>(
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Lock cwd unless it resolves to the same canonical checkout as comparisonPath. */
    readonly withCheckoutUnlessSameRoot: <A, E, R>(
      cwd: string,
      comparisonPath: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly tryWithCheckout: <A, E, R>(
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
    readonly beginFinalization: (eventId: string, cwd: string) => Effect.Effect<void>;
    readonly endFinalization: (eventId: string) => Effect.Effect<void>;
    readonly isFinalizing: (cwd: string) => Effect.Effect<boolean>;
  }
>()("t3/git/CheckoutCoordinator") {}

export const CheckoutCoordinatorLive = Layer.effect(
  CheckoutCoordinator,
  Effect.sync(() => {
    const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
    const finalizations = new Map<string, Set<string>>();
    const canonical = (cwd: string) =>
      Effect.promise(
        async () => (await resolveGitWorktreeRoot(cwd)) ?? (await canonicalizeWorktreePath(cwd)),
      );
    const withLock = <A, E, R>(
      cwd: string,
      use: (lock: Semaphore.Semaphore) => Effect.Effect<A, E, R>,
    ) =>
      Effect.flatMap(canonical(cwd), (key) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const entry = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
            entry.users++;
            locks.set(key, entry);
            return entry;
          }),
          (entry) => use(entry.semaphore),
          (entry) =>
            Effect.sync(() => {
              if (--entry.users === 0) locks.delete(key);
            }),
        ),
      );

    return {
      withCheckout: (cwd, effect) => withLock(cwd, (lock) => lock.withPermits(1)(effect)),
      withCheckoutUnlessSameRoot: (cwd, comparisonPath, effect) =>
        Effect.flatMap(
          Effect.all([canonical(cwd), canonical(comparisonPath)], { concurrency: "unbounded" }),
          ([cwdKey, comparisonKey]) =>
            cwdKey === comparisonKey
              ? effect
              : withLock(cwd, (lock) => lock.withPermits(1)(effect)),
        ),
      tryWithCheckout: (cwd, effect) =>
        withLock(cwd, (lock) => lock.withPermitsIfAvailable(1)(effect)),
      beginFinalization: (eventId, cwd) =>
        Effect.flatMap(canonical(cwd), (key) =>
          Effect.sync(() => {
            const paths = finalizations.get(eventId) ?? new Set<string>();
            paths.add(key);
            finalizations.set(eventId, paths);
          }),
        ),
      endFinalization: (eventId) =>
        Effect.sync(() => {
          finalizations.delete(eventId);
        }),
      isFinalizing: (cwd) =>
        Effect.suspend(() =>
          finalizations.size === 0
            ? Effect.succeed(false)
            : Effect.map(canonical(cwd), (key) =>
                [...finalizations.values()].some((paths) => paths.has(key)),
              ),
        ),
    };
  }),
);
