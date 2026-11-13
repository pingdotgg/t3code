import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  type ApplicationStoredEvent,
  CheckpointId,
  CheckpointRef,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  type PullRequestDetail,
  type PullRequestComment,
  PullRequestOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ROLLBACK_FAILED_MESSAGE } from "./CheckpointRollbackService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import { PULL_REQUEST_WATCH_WAKE_LIMIT } from "./pullRequestWatch.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { shellStreamItemFromThreadShell } from "./ShellStream.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { modelSelection, seedProject, layerTest } from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerTest)("usage-limit recovery", (it) => {
  it.effect.each([
    "resume",
    "queued-resume",
    "rearm",
    "snooze-race",
    "archive",
    "replacement",
    "manual-snooze",
    "invalid-snooze",
    "cancel-resume-keep-snooze",
    "independent-patches",
    "expired-snooze",
    "wake",
    "stop",
    "stop-before-arm",
    "stop-before-arm-mismatched-recovery",
  ] as const)("guards a scheduled usage-limit continuation against %s", (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`recovery:${scenario}`);
      const projectId = ProjectId.make(`recovery:project:${scenario}`);
      yield* seedProject({
        projectId,
        title: "Recovery project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`recovery:create:${scenario}`),
        threadId,
        projectId,
        title: "Limited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`recovery:message:${scenario}`),
        threadId,
        messageId: MessageId.make(`recovery:message:${scenario}`),
        text: "Work on this.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      if (scenario === "queued-resume") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`recovery:queued:${scenario}`),
          threadId,
          messageId: MessageId.make(`recovery:queued:${scenario}`),
          text: "Run after recovery.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const now = yield* DateTime.now;
      const resetAt =
        scenario === "invalid-snooze"
          ? "not-a-date"
          : DateTime.formatIso(DateTime.add(now, { minutes: 1 })).replace(
              "Z",
              scenario === "wake" ? "+00:00" : "Z",
            );
      yield* events.write({
        commandId: CommandId.make(`recovery:failure:${scenario}`),
        events: [
          {
            id: EventId.make(`recovery:run:${scenario}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "failed", completedAt: now },
          },
          {
            id: EventId.make(`recovery:error:${scenario}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`recovery:error:${scenario}`),
              type: "error",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit reached",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Plan limit reached.",
                code: "usageLimitExceeded",
                retryable: null,
                resetAt,
              },
            },
          },
        ],
      });
      if (scenario === "queued-resume") {
        const queuedRun = projection.runs[1]!;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:held:queued-resume"),
              type: "run.updated",
              threadId,
              runId: queuedRun.id,
              occurredAt: now,
              payload: { ...queuedRun, queueHeld: true },
            },
          ],
        });
        const resumeHeldQueue = yield* orchestrator
          .dispatch({
            type: "queue.resume",
            commandId: CommandId.make("recovery:resume-held:queued-resume"),
            threadId,
          })
          .pipe(Effect.exit);
        assert.equal(resumeHeldQueue._tag, "Failure");
        assert.isTrue((yield* orchestrator.getThreadProjection(threadId)).runs[1]?.queueHeld);
      }
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.isNull(limitRecoveryCommand(shell, false, DateTime.toEpochMillis(now)));
      if (scenario === "invalid-snooze") {
        const result = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:invalid-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.limitRecovery ?? null);
        assert.isNull(current.thread.snoozedUntil);
        return;
      }
      const snooze = scenario === "wake" || scenario === "cancel-resume-keep-snooze";
      const autoResume = scenario !== "wake";
      const arm = limitRecoveryCommand(shell, autoResume, DateTime.toEpochMillis(now), snooze);
      assert(arm?.type === "thread.metadata.update" && arm.limitRecovery != null);
      const automaticArm = {
        commandId: arm.commandId,
        threadId,
        limitRecovery: arm.limitRecovery,
      };
      const stopBeforeArm =
        scenario === "stop-before-arm" || scenario === "stop-before-arm-mismatched-recovery";
      if (stopBeforeArm) {
        if (scenario === "stop-before-arm-mismatched-recovery") {
          const current = yield* orchestrator.getThreadProjection(threadId);
          yield* events.write({
            events: [
              {
                id: EventId.make(`recovery:older-window:${scenario}`),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...current.thread,
                  limitRecovery: {
                    runId: run.id,
                    resetAt: DateTime.formatIso(DateTime.add(now, { minutes: 2 })),
                    autoResume: true,
                    snooze: false,
                  },
                },
              },
            ],
          });
        }
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`recovery:stop:${scenario}`),
          threadId,
        });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.isUndefined(
          (yield* projections.getLimitRecoveryCandidates({
            now,
            autoResume: true,
            snooze: false,
          })).find((row) => row.id === threadId),
        );
        const stoppedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.isNull(limitRecoveryCommand(stoppedShell, true, DateTime.toEpochMillis(now)));
        yield* orchestrator.autoArmLimitRecovery(automaticArm);
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.limitRecovery, {
          runId: run.id,
          resetAt,
          autoResume: false,
          snooze: false,
          requestId: CommandId.make(`recovery:stop:${scenario}`),
        });
      }
      const armCommand = stopBeforeArm
        ? { ...arm, commandId: CommandId.make(`recovery:explicit-rearm:${scenario}`) }
        : arm;
      if (stopBeforeArm) yield* orchestrator.dispatch(armCommand);
      else yield* orchestrator.autoArmLimitRecovery(automaticArm);
      let armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.deepEqual(armedShell.limitRecovery, {
        runId: run.id,
        resetAt,
        autoResume,
        snooze,
        requestId: armCommand.commandId,
      });
      if (snooze)
        assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
      if (scenario === "cancel-resume-keep-snooze") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:independent-choice:${scenario}`),
          threadId,
          limitRecovery: {
            runId: run.id,
            resetAt,
            autoResume: false,
            snooze: true,
          },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
        assert.equal(
          DateTime.toEpochMillis(armedShell.snoozedAt!),
          DateTime.toEpochMillis(armedShell.updatedAt),
        );
        assert.isFalse(armedShell.limitRecovery!.autoResume);
      }
      if (scenario === "independent-patches") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-snooze"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, snooze: true },
        });
        let current = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-cancel-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
        current = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        assert.equal(DateTime.toEpochMillis(current.thread.snoozedUntil!), Date.parse(resetAt));
        assert.equal(
          DateTime.toEpochMillis(current.thread.snoozedAt!),
          DateTime.toEpochMillis(current.thread.updatedAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.isTrue(armedShell.limitRecovery!.autoResume);
        assert.isTrue(armedShell.limitRecovery!.snooze);
      }
      if (scenario === "manual-snooze") {
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`recovery:manual-snooze:${scenario}`),
          threadId,
          snoozedUntil: resetAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:manual-cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false, snooze: false },
        });
        assert.equal(
          DateTime.toEpochMillis(
            (yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil!,
          ),
          Date.parse(resetAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.unsnooze",
          commandId: CommandId.make(`recovery:manual-wake:${scenario}`),
          threadId,
          reason: "user",
        });
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
      }
      if (scenario === "wake") {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:wake:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false, snooze: false },
        });
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
      }
      assert.isNull(limitRecoveryCommand(armedShell, true, DateTime.toEpochMillis(now)));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`recovery:early:${scenario}`),
        messageId: MessageId.make(`recovery:early:${scenario}`),
        threadId,
        usageLimitContinuationOfRunId: run.id,
        text: "Continue where you left off.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).runs,
        scenario === "queued-resume" ? 2 : 1,
      );
      yield* TestClock.adjust("1 minute");
      const resume = limitRecoveryCommand(
        armedShell,
        true,
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      if (autoResume && scenario !== "cancel-resume-keep-snooze") assert.isNotNull(resume);
      else assert.isNull(resume);
      if (scenario === "snooze-race") {
        const wakeAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 }));
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("recovery:raced-snooze"),
          threadId,
          snoozedUntil: wakeAt,
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        yield* TestClock.adjust("1 minute");
        const current = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          current,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      if (scenario === "expired-snooze") {
        const staleSnooze = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:expired-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(staleSnooze._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.snoozedUntil);
        assert.isFalse(current.thread.limitRecovery!.snooze);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
      }

      if (scenario === "rearm")
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
      if (scenario === "archive")
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`recovery:archive:${scenario}`),
          threadId,
        });
      if (scenario === "stop") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`recovery:stop:${scenario}`),
          threadId,
        });
        const stoppedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.deepInclude(stoppedShell.limitRecovery, { runId: run.id, autoResume: false });
      }
      if (scenario === "replacement") {
        const current = yield* orchestrator.getThreadProjection(threadId);
        const error = current.turnItems.find((item) => item.type === "error")!;
        if (error.type !== "error") throw new Error("Expected provider error");
        yield* events.write({
          commandId: CommandId.make(`recovery:replacement:${scenario}`),
          events: [
            {
              id: EventId.make(`recovery:replacement:${scenario}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...error,
                failure: {
                  ...error.failure,
                  class: "provider_error",
                  message: "A replacement failure.",
                },
              },
            },
          ],
        });
      }
      if (scenario === "rearm") {
        yield* orchestrator.dispatch(resume!);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:rearm:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        const rearmedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          rearmedShell,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      if (resume !== null) {
        yield* orchestrator.dispatch(resume);
        yield* orchestrator.dispatch(resume);
      }
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        after.runs,
        before.runs.length +
          (scenario === "resume" ||
          stopBeforeArm ||
          scenario === "queued-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      assert.lengthOf(
        after.messages,
        before.messages.length +
          (scenario === "resume" ||
          stopBeforeArm ||
          scenario === "queued-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      if (scenario === "stop") {
        assert.deepInclude(after.thread.limitRecovery, { runId: run.id, autoResume: false });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sweep = { now: yield* DateTime.now, autoResume: true, snooze: false };
        assert.isUndefined(
          (yield* projections.getLimitRecoveryCandidates(sweep)).find((row) => row.id === threadId),
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:rearm-after-stop"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        const rearmed = (yield* projections.getLimitRecoveryCandidates(sweep)).find(
          (row) => row.id === threadId,
        )!;
        assert.isDefined(rearmed);
        const freshResume = limitRecoveryCommand(rearmed, true, DateTime.toEpochMillis(sweep.now));
        assert.isNotNull(freshResume);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      if (scenario === "queued-resume") {
        const held = after.runs[1]!;
        assert.equal(held.status, "queued");
        assert.isTrue(held.queueHeld);
        const continuation = after.runs[2]!;
        const completedAt = yield* DateTime.now;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:continuation-completed:queued-resume"),
              type: "run.updated",
              threadId,
              runId: continuation.id,
              occurredAt: completedAt,
              payload: { ...continuation, status: "completed", completedAt },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("recovery:resume-held-after-limit:queued-resume"),
          threadId,
        });
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          resumed.runs.map((run) => run.id),
          [run.id, continuation.id, held.id],
        );
        assert.equal(resumed.runs[2]?.status, "starting");
        assert.isFalse(resumed.runs[2]?.queueHeld);
      }
    }),
  );
});
