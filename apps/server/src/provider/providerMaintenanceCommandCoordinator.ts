import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

/** One permit per process: background installs hold it, provider turn starts wait for it. */
export class ProviderMaintenanceAdmission extends Context.Reference<{
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}>("t3/provider/providerMaintenanceCommandCoordinator/ProviderMaintenanceAdmission", {
  defaultValue: () => ({ withPermit: Semaphore.makeUnsafe(1).withPermits(1) }),
}) {}

export interface ProviderMaintenanceCommandCoordinatorShape<E> {
  readonly withCommandLock: <A, R>(input: {
    readonly targetKey: string;
    readonly lockKey: string;
    readonly onQueued?: Effect.Effect<void, E, R>;
    readonly onInterrupted?: Effect.Effect<void, E, R>;
    readonly run: Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E, R>;
}

export const makeProviderMaintenanceCommandCoordinator = Effect.fn(
  "makeProviderMaintenanceCommandCoordinator",
)(function* <E>(input: { readonly makeAlreadyRunningError: (targetKey: string) => E }) {
  const runningTargetsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const locks = yield* KeyedLock.make<string>();

  const acquireTarget = Effect.fn("acquireTarget")(function* (targetKey: string) {
    return yield* Ref.modify(runningTargetsRef, (runningTargets) => {
      if (runningTargets.has(targetKey)) {
        return [false, runningTargets] as const;
      }
      const next = new Set(runningTargets);
      next.add(targetKey);
      return [true, next] as const;
    });
  });

  const releaseTarget = (targetKey: string) =>
    Ref.update(runningTargetsRef, (runningTargets) => {
      const next = new Set(runningTargets);
      next.delete(targetKey);
      return next;
    });

  const withCommandLock: ProviderMaintenanceCommandCoordinatorShape<E>["withCommandLock"] = ({
    targetKey,
    lockKey,
    onQueued,
    onInterrupted,
    run,
  }) =>
    Effect.gen(function* () {
      const acquired = yield* acquireTarget(targetKey);
      if (!acquired) {
        return yield* Effect.fail(input.makeAlreadyRunningError(targetKey));
      }

      return yield* (onQueued ?? Effect.void).pipe(
        Effect.andThen(locks.withLock(lockKey, run)),
        Effect.onInterrupt(() => onInterrupted ?? Effect.void),
        Effect.ensuring(releaseTarget(targetKey)),
      );
    });

  return {
    withCommandLock,
  } satisfies ProviderMaintenanceCommandCoordinatorShape<E>;
});
