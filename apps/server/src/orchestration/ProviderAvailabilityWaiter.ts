import {
  CommandId,
  type ThreadId,
  isProviderAvailable,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { modelUsageAvailability } from "@t3tools/shared/usageLimits";
import { pendingProviderTurnUpdate } from "@t3tools/shared/pendingProviderTurn";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";

/** Watches only explicitly queued threads. The server owns the wait so a
 * disconnected client never needs a timer or an open tab. */
export const makeProviderAvailabilityWaiter = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const registry = yield* ProviderRegistry;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
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
      const turn = thread.pendingProviderTurn!;
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
      const now = DateTime.toEpochMillis(yield* DateTime.now);
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
      const availability = modelUsageAvailability(provider.usageLimits, selection.model, now);
      if (
        refresh &&
        availability.status !== "available" &&
        (availability.resetsAt === null ||
          availability.resetsAt <= now ||
          now - Date.parse(provider.usageLimits?.checkedAt ?? "") > 5 * 60_000) &&
        !refreshed.has(selection.instanceId)
      ) {
        refreshed.add(selection.instanceId);
        provider = (yield* registry.refreshInstance(selection.instanceId)).find(
          (entry) => entry.instanceId === selection.instanceId,
        );
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
      yield* engine
        .dispatch({
          type: "thread.turn.release",
          commandId: CommandId.make(`provider-available:${yield* crypto.randomUUIDv4}`),
          threadId,
          messageId: turn.message.messageId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.catch(() => Effect.void));
    }
  });
  const worker = yield* makeDrainableWorker((refresh: boolean) =>
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
