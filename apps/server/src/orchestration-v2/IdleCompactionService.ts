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

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { idleCompactionWindow, MAX_PROMPT_CACHE_TTL } from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Beta: when a run completes on a Claude instance set to compact before the
 * cache expires, waits until shortly before its prompt cache expires and sends
 * `/compact` as a visible T3 Code turn. On start it re-arms runs that completed before a restart.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  const compactWhenDue = Effect.fn("IdleCompactionService.compactWhenDue")(
    function* (threadId: ThreadId, runId: RunId) {
      // Loops once after the wait: the thread may have moved on.
      while (true) {
        const current = yield* settings.getSettings;
        const thread = yield* projections.getThread(threadId);
        const claudeInstance = Object.hasOwn(current.providerInstances, thread.providerInstanceId)
          ? current.providerInstances[thread.providerInstanceId]?.driver === "claudeAgent"
          : thread.providerInstanceId === "claudeAgent";
        if (
          !claudeInstance ||
          resolveIdleCompaction(current, thread.providerInstanceId) !== "beforeCacheExpires" ||
          !resolveProjectProviderInstanceEnabled(
            current,
            thread.projectId,
            thread.providerInstanceId,
          )
        )
          return;
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
        if (
          resolveIdleCompaction(current, records.thread.providerInstanceId) !==
            "beforeCacheExpires" ||
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
        if (nowMs < window.startMs) {
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
    const rearm = Effect.fn("IdleCompactionService.rearm")(
      function* () {
        const completedAfter = DateTime.subtractDuration(yield* DateTime.now, MAX_PROMPT_CACHE_TTL);
        const candidates = yield* projections.listIdleCompactionCandidates({ completedAfter });
        yield* Effect.forEach(
          candidates,
          ({ threadId, runId }) =>
            // A timer armed by a live event is newer than the scan.
            FiberMap.run(timers, threadId, compactWhenDue(threadId, runId), {
              onlyIfMissing: true,
            }),
          { discard: true },
        );
      },
      Effect.catch((cause) => Effect.logWarning("idle compaction rearm skipped", { cause })),
    );
    yield* forkParked(
      Effect.all(
        [
          Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
            event.type === "run.updated" && event.payload.status === "completed"
              ? FiberMap.run(
                  timers,
                  event.threadId,
                  compactWhenDue(event.threadId, event.payload.id),
                )
              : Effect.void,
          ),
          rearm(),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );
  });
  return { start };
});
