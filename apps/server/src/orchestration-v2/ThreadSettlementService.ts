import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { CommandId, type ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  isAutoArchiveDue,
  resolveAutoSettlementAt,
  resolveFinishedChildSettlementAt,
} from "./autoSettlement.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
// Bounds the backlog a first sweep archives at once; the rest follow on later sweeps.
const AUTO_ARCHIVE_BATCH = 100;

export class ThreadSettlementServiceV2 extends Context.Service<
  ThreadSettlementServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadSettlementService/ThreadSettlementServiceV2") {}

/** Identity of age settings; unrelated edits do not trigger a sweep. */
function autoSettlementSettingsKey(settings: import("@t3tools/contracts").ServerSettings): string {
  return JSON.stringify([
    settings.autoArchiveSettledAfterDays,
    settings.autoSettleFinishedChildrenAfterHours,
    settings.sidebarAutoSettleAfterDays,
    settings.sidebarAutoSettleKeepPullRequests,
    Object.entries(settings.projectSettingsOverrides)
      .filter(
        ([, entry]) =>
          entry.sidebarAutoSettleAfterDays !== undefined ||
          entry.sidebarAutoSettleKeepPullRequests !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entry]) => [
        projectId,
        entry.sidebarAutoSettleAfterDays,
        entry.sidebarAutoSettleKeepPullRequests ?? "inherit",
      ]),
  ]);
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const terminals = yield* TerminalManager.TerminalManager;
  const projectScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  // Settling a settled thread re-emits thread.settled with the same settledAt,
  // so this keeps the settle action to one run per settlement.
  const settleActionRunAt = new Map<ThreadId, number>();

  const archiveSweep = Effect.fn("ThreadSettlementServiceV2.archiveSweep")(function* () {
    const afterDays = (yield* settingsService.getSettings).autoArchiveSettledAfterDays;
    if (afterDays <= 0) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const threads = yield* projections
      .getAutoArchiveCandidates({
        settledBefore: DateTime.makeUnsafe(nowMs - afterDays * DAY_MS),
        limit: AUTO_ARCHIVE_BATCH,
      })
      .pipe(NodeSqliteClient.readOnlyBackground);
    // Serial: each archive is its own command and event, so a backlog trickles to clients.
    yield* Effect.forEach(
      threads,
      (thread) =>
        Effect.gen(function* () {
          if (!isAutoArchiveDue(thread, { nowMs, afterDays })) return;
          if (yield* projections.hasActiveDescendants(thread.id)) return;
          yield* orchestrator.dispatch({
            type: "thread.auto-archive",
            commandId: CommandId.make(`server:auto-archive:${thread.id}:${yield* random.uuidV4()}`),
            threadId: thread.id,
            snapshotAt: thread.updatedAt,
          });
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("automatic thread archiving skipped", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      { discard: true },
    );
  });

  const sweep = Effect.fn("ThreadSettlementServiceV2.sweep")(function* (threadId?: ThreadId) {
    // Archiving reads only settled threads, so it runs on the periodic sweep alone.
    if (threadId === undefined)
      yield* archiveSweep().pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("automatic thread archiving sweep failed", {
              cause: Cause.pretty(cause),
            }),
        ),
      );
    const settings = yield* settingsService.getSettings;
    const enabled = (days: number | null | undefined) => days != null && days > 0;
    if (
      !enabled(settings.autoSettleFinishedChildrenAfterHours) &&
      !enabled(settings.sidebarAutoSettleAfterDays) &&
      !Object.values(settings.projectSettingsOverrides).some((entry) =>
        enabled(entry.sidebarAutoSettleAfterDays),
      )
    )
      return;
    const threads = yield* projections
      .getSettlementCandidates(threadId)
      .pipe(NodeSqliteClient.readOnlyBackground);
    yield* Effect.forEach(
      threads,
      (thread) =>
        Effect.gen(function* () {
          const current = resolveProjectSettings(
            yield* settingsService.getSettings,
            thread.projectId,
          ).settings;
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          // The deadline is recomputed from persisted activity on every sweep, so a
          // restart neither loses nor restarts a child's clock.
          const finishedChildAt = resolveFinishedChildSettlementAt({
            thread,
            nowMs,
            afterHours: current.autoSettleFinishedChildrenAfterHours,
            autoSettleKeepPullRequests: current.sidebarAutoSettleKeepPullRequests,
          });
          const settledAt =
            finishedChildAt ??
            resolveAutoSettlementAt({
              thread,
              nowMs,
              autoSettleAfterDays: current.sidebarAutoSettleAfterDays,
              autoSettleKeepPullRequests: current.sidebarAutoSettleKeepPullRequests,
            });
          if (settledAt === null || (yield* projections.hasActiveDescendants(thread.id))) return;
          // Age settlement belongs to this card alone: child chats and subagents
          // retain their own clocks. A finished child settles like a manual settle,
          // taking its sub-runs along; its parent is never touched.
          yield* orchestrator.dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make(`server:auto-settle:${thread.id}:${yield* random.uuidV4()}`),
            threadId: thread.id,
            snapshotAt: thread.updatedAt,
            settledAt,
            ...(finishedChildAt === null ? {} : { reason: "finished-child" as const }),
          });
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("automatic thread settlement skipped", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });
  const worker = yield* makeDrainableWorker((threadId: ThreadId | undefined) =>
    sweep(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("automatic thread settlement sweep failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  // Close idle prompts and run the settle script only in an isolated worktree; live terminals stay open.
  const cleanUpSettledThread = Effect.fn("ThreadSettlementServiceV2.cleanUpSettledThread")(
    function* (threadId: ThreadId) {
      // A thread re-engaged before this event ran keeps its shells.
      const settled = yield* projections.getThread(threadId);
      if (settled.settledOverride !== "settled") return;
      yield* terminals.closeOnSettle({ threadId });
      const worktreePath = settled.worktreePath;
      if (worktreePath === null || !(yield* fileSystem.exists(worktreePath))) return;
      // Closing and the worktree check wait on I/O. A thread re-engaged
      // meanwhile is working again, so its worktree is no place for cleanup.
      const thread = yield* projections.getThread(threadId);
      if (thread.settledOverride !== "settled") return;
      const settledAtMs =
        thread.settledAt == null ? null : DateTime.toEpochMillis(thread.settledAt);
      if (settledAtMs === null || settleActionRunAt.get(threadId) === settledAtMs) return;
      const run = yield* projectScripts.runForThread({
        threadId,
        projectId: thread.projectId,
        worktreePath,
        trigger: "settle",
        // A clean exit closes the script's shell so it does not hold the worktree.
        observeCompletion: {},
      });
      // Recorded after a successful start, so a failed start retries on the next event.
      settleActionRunAt.set(threadId, settledAtMs);
      if (run.status === "started" && run.completion) {
        yield* run.completion.pipe(Effect.forkDetach);
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("cleaning up a settled thread failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.settled":
        return cleanUpSettledThread(event.threadId);
      case "thread.pull-request-link-updated":
      case "thread.pull-request-synced":
      case "provider-session.detached":
        return worker.enqueue(event.threadId);
      case "provider-session.updated":
        return event.payload.status !== "starting" && event.payload.status !== "running"
          ? worker.enqueue(event.threadId)
          : Effect.void;
      case "run.updated":
        return ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
          event.payload.status,
        )
          ? worker.enqueue(event.threadId)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: ThreadSettlementServiceV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementServiceV2.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const events = orchestrator.streamDomainEvents;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastSettlementSettings = autoSettlementSettingsKey(initialSettings);
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        const key = autoSettlementSettingsKey(settings);
        if (key === lastSettlementSettings) {
          return Effect.void;
        }
        lastSettlementSettings = key;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, processEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread settlement event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementServiceV2["Service"];
});

export const layer = Layer.effect(ThreadSettlementServiceV2, make);
