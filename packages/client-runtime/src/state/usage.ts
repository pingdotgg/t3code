import type { EnvironmentId, UsageModelFilter, UsageSummaryInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import {
  awaitAtomResult,
  captureAtomResult,
  observeAtomCommand,
  reportAtomCommandResult,
  squashAtomCommandFailure,
} from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/** The Usage tab asks each environment with that environment's configured model filter. */
export function usageSummaryInput(
  input: UsageSummaryInput,
  modelFilter: UsageModelFilter | undefined,
): UsageSummaryInput {
  return modelFilter === undefined ? input : { ...input, modelFilter };
}

const limitsRefreshAfter = new Map<EnvironmentId, number>();
const limitsRefreshes = new Map<EnvironmentId, Deferred.Deferred<unknown, unknown>>();

export const refreshUsageLimits = Effect.fn("Usage.refreshLimits")(function* <A, E, R>(
  environmentId: EnvironmentId,
  refresh: Effect.Effect<A, E, R>,
  automatic = false,
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const pending = limitsRefreshes.get(environmentId);
      if (pending !== undefined) {
        return automatic
          ? undefined
          : yield* restore(Deferred.await(pending as Deferred.Deferred<A, E>));
      }
      const now = yield* Clock.currentTimeMillis;
      if (automatic && now < (limitsRefreshAfter.get(environmentId) ?? 0)) return;
      const result = Deferred.makeUnsafe<A, E>();
      limitsRefreshes.set(environmentId, result as Deferred.Deferred<unknown, unknown>);
      yield* refresh.pipe(
        Effect.interruptible,
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const finishedAt = yield* Clock.currentTimeMillis;
            limitsRefreshes.delete(environmentId);
            limitsRefreshAfter.set(environmentId, finishedAt + 5 * 60_000);
            yield* Deferred.done(result, exit);
          }),
        ),
        Effect.ignoreCause,
        Effect.forkDetach({ startImmediately: true }),
      );
      return yield* restore(Deferred.await(result));
    }),
  );
});

export const refreshUsage = Effect.fn("Usage.refresh")(function* ({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "usageSummary" | "refreshUsageRates" | "usageModelFilterAtom"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}) {
  yield* Effect.forEach(
    environmentIds,
    (environmentId) =>
      Effect.gen(function* () {
        const query = server.usageSummary({
          environmentId,
          input: usageSummaryInput(input, registry.get(server.usageModelFilterAtom(environmentId))),
        });
        const presentation = presentations.presentationAtom(environmentId);
        const disconnected = yield* Deferred.make<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            registry.subscribe(
              presentation,
              (value) => {
                if (value?.connection.phase !== "connected") {
                  Deferred.doneUnsafe(disconnected, Effect.void);
                }
              },
              { immediate: true },
            ),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
        const ratesResult = yield* observeAtomCommand(
          registry,
          server.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        registry.refresh(query);
        if (
          ratesResult._tag === "Failure" &&
          isEnvironmentRpcUnavailable(squashAtomCommandFailure(ratesResult))
        )
          return;
        if (yield* Deferred.isDone(disconnected)) return;
        yield* Effect.raceFirst(
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off
          captureAtomResult(awaitAtomResult(registry, query)).pipe(
            Effect.flatMap((result) =>
              Effect.sync(() => reportAtomCommandResult(result, { reportFailure: false })),
            ),
          ),
          Deferred.await(disconnected),
        );
      }).pipe(Effect.scoped),
    { concurrency: "unbounded", discard: true },
  );
});
