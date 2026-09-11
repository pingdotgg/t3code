import {
  CommandId,
  type ThreadId,
  isProviderAvailable,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { modelUsageAvailability } from "@t3tools/shared/usageLimits";
import { pendingProviderTurnUpdate } from "@t3tools/shared/pendingProviderTurn";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";

/** Watches only explicitly queued threads. The server owns the wait so a
 * disconnected client never needs a timer or an open tab. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const pending = new Set<ThreadId>();

  const check = Effect.fn("ProviderAvailabilityWaiter.check")(function* (refresh: boolean) {
    const refreshed = new Set<string>();
    for (const threadId of pending) {
      const result = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(result) || result.value.pendingProviderTurn == null) {
        pending.delete(threadId);
        continue;
      }
      const thread = result.value;
      const turn = yield* snapshots
        .getPendingProviderTurn(threadId)
        .pipe(Effect.map(Option.flatten), Effect.map(Option.getOrUndefined));
      if (turn == null) {
        pending.delete(threadId);
        continue;
      }
      const selection = turn.modelSelection;
      if (
        thread.archivedAt !== null ||
        thread.settledOverride === "settled" ||
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.session?.status === "running" ||
        thread.session?.status === "starting"
      )
        continue;
      let provider = (yield* registry.getProviders).find(
        (entry) => entry.instanceId === selection.instanceId,
      );
      if (
        !provider ||
        !provider.enabled ||
        !provider.installed ||
        !isProviderAvailable(provider) ||
        provider.status !== "ready"
      )
        continue;
      if (refresh && !refreshed.has(selection.instanceId)) {
        refreshed.add(selection.instanceId);
        const refreshedProvider = (yield* registry.refreshInstance(selection.instanceId)).find(
          (entry) => entry.instanceId === selection.instanceId,
        );
        // refreshInstance recovers failures with the cached list; an identical
        // entry means no fresh read happened, so this check is inconclusive.
        if (refreshedProvider === provider) continue;
        provider = refreshedProvider;
      }
      if (
        !provider ||
        !provider.enabled ||
        !provider.installed ||
        provider.status !== "ready" ||
        !isProviderAvailable(provider) ||
        modelUsageAvailability(
          provider.usageLimits,
          selection.model,
          DateTime.toEpochMillis(yield* DateTime.now),
        ).status !== "available"
      )
        continue;
      if (!refresh) {
        // A cached snapshot can read "available" only because its reset
        // timestamp elapsed. Refresh the instance before any release so a
        // fresh positive quota check is what starts the work.
        yield* worker.enqueue(true);
        continue;
      }
      yield* engine
        .dispatch({
          type: "thread.turn.release",
          commandId: CommandId.make(`provider-available:${yield* crypto.randomUUIDv4}`),
          threadId,
          messageId: turn.message.messageId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          // The release is handed off until the session adopts it or the wait
          // is re-queued; a second dispatch would emit a duplicate turn start.
          Effect.tap(() => Effect.sync(() => pending.delete(threadId))),
          Effect.catch((error) =>
            error._tag === "OrchestrationCommandInvariantError" &&
            error.detail === "The pending provider turn is no longer eligible to start."
              ? Effect.void
              : Effect.logWarning("Could not release queued provider turn", { threadId, error }),
          ),
        );
    }
  });
  const worker: DrainableWorker<boolean> = yield* makeDrainableWorker((refresh: boolean) =>
    check(refresh).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not check queued provider turns", { error }),
      ),
    ),
  );
  return {
    start: Effect.gen(function* () {
      const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.orDie);
      for (const thread of snapshot.threads)
        if (thread.pendingProviderTurn != null) pending.add(thread.id);
      yield* forkParked(Stream.runForEach(registry.streamChanges, () => worker.enqueue(false)));
      yield* forkParked(Effect.repeat(worker.enqueue(true), Schedule.spaced("1 minute")));
    }),
    onEvent: (event: OrchestrationEvent) =>
      Effect.gen(function* () {
        const update = pendingProviderTurnUpdate(event);
        if (update !== undefined && "threadId" in event.payload) {
          if (update === null) pending.delete(event.payload.threadId);
          else pending.add(event.payload.threadId);
          yield* worker.enqueue(false);
        }
      }),
    drain: worker.drain,
  };
});
