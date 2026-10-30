import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { idleCompactionAction, idleCompactionWindow } from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Beta: sends `/compact` shortly before a completed Claude run's prompt cache
 * expires, or at once with `compactBeforeUsageLimit` when a nearly spent usage
 * limit outlasts the cache. Timers live in memory; a restart skips waiting ones.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const compactWhenDue = Effect.fn("IdleCompactionService.compactWhenDue")(
    function* (threadId: ThreadId, runId: RunId) {
      // Loops once after the wait: the thread may have moved on.
      while (true) {
        const current = yield* settings.getSettings;
        const records = yield* projections.getThreadRecords(
          threadId,
          [
            "runs",
            "messages",
            "providerThreads",
            "providerTurns",
            "runtimeRequests",
            "turnItems",
            "contextTransfers",
          ],
          { messageRunIds: [runId], turnItemStatuses: ["pending", "running", "waiting"] },
        );
        const mode = resolveIdleCompaction(current, records.thread.providerInstanceId);
        if (
          mode === "off" ||
          (mode !== "beforeCacheExpires" && !current.compactBeforeUsageLimit) ||
          !resolveProjectProviderInstanceEnabled(
            current,
            records.thread.projectId,
            records.thread.providerInstanceId,
          )
        )
          return;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const window = idleCompactionWindow(records, nowMs);
        if (window?.runId !== runId) return;
        // The instance snapshot, not the registry list: the registry applies the
        // run's last usage update asynchronously and can still be behind here.
        const instance = current.compactBeforeUsageLimit
          ? yield* providerInstances.getInstance(records.thread.providerInstanceId)
          : undefined;
        const action = idleCompactionAction({
          mode,
          compactBeforeUsageLimit: current.compactBeforeUsageLimit,
          window,
          usageWindows:
            instance === undefined
              ? []
              : ((yield* instance.snapshot.getSnapshot).usageLimits?.windows ?? []),
          nowMs,
        });
        if (action === "skip") return;
        if (action === "wait") {
          yield* Effect.sleep(Duration.millis(window.startMs - nowMs));
          continue;
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          // One compaction per completed run, even across duplicate events.
          commandId: CommandId.make(`server:idle-compact:${threadId}:${runId}`),
          messageId: MessageId.make(`idle-compact:${threadId}:${runId}`),
          threadId,
          text: IDLE_COMPACTION_TEXT,
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          idleCompaction: "beforeCacheExpires",
          dispatchMode: { type: "start_immediately" },
        });
        return;
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) => Effect.logWarning("idle compaction skipped", { threadId, cause })),
      ),
  );

  const start = Effect.fn("IdleCompactionService.start")(function* () {
    // Keyed by thread: a newer completed run replaces the waiting timer.
    const timers = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? FiberMap.run(timers, event.threadId, compactWhenDue(event.threadId, event.payload.id))
          : Effect.void,
      ),
    );
  });
  return { start };
});
