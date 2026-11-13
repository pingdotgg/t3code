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

import { modelSelection, layerTest, setup } from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("settles past held automatic runs but not held user messages", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-settle-automatic-queued");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("settle-automatic-create"),
        threadId,
        projectId: ProjectId.make("settle-automatic-project"),
        title: "Settle automatic queued",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-settle-automatic",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("settle-automatic-active"),
        threadId,
        messageId: MessageId.make("settle-automatic-active"),
        text: "Active",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const queueMessage = (id: string, automatic: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: automatic ? "agent" : "user",
          creationSource: automatic ? "provider" : "web",
          ...(automatic
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : {}),
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: id,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
      yield* queueMessage("settle-automatic-notification", true);

      const holdQueueAfterRestart = (commandId: string) =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const now = yield* DateTime.now;
          yield* eventSink.commitCommand({
            commandId: CommandId.make(commandId),
            threadId,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events: projection.runs
              .filter((run) => run.status === "starting" || run.status === "queued")
              .map((run) => ({
                id: EventId.make(`${commandId}:${run.id}`),
                type: "run.updated" as const,
                threadId,
                runId: run.id,
                occurredAt: now,
                payload:
                  run.status === "queued"
                    ? { ...run, queueHeld: true }
                    : { ...run, status: "cancelled" as const, completedAt: now },
              })),
            effects: [],
          });
        });
      yield* holdQueueAfterRestart("settle-automatic-restart");

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle-automatic-settle"),
        threadId,
      });
      const settled = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(settled.thread.settledAt);
      assert.isTrue(settled.runs.every((run) => run.status === "cancelled"));

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("settle-automatic-unsettle"),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("settle-automatic-active-2"),
        threadId,
        messageId: MessageId.make("settle-automatic-active-2"),
        text: "Active again",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* queueMessage("settle-automatic-user-queued", false);
      yield* holdQueueAfterRestart("settle-automatic-restart-2");
      const error = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-automatic-settle-2"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(
        error.cause,
        `Thread ${threadId} has a queued message. Send it or remove it from the queue before settling.`,
      );
    }),
  );
  it.effect("cancels preparing work on archive and keeps it cancelled through replay", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-layer-archive-preparing-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-preparing-create"),
        threadId,
        projectId: ProjectId.make("archive-preparing-project"),
        title: "Archive preparing work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-preparing-message"),
        threadId,
        messageId: MessageId.make("archive-preparing-message"),
        text: "Prepare my workspace.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "defer_start" },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(before.runs, 1);
      assert.isEmpty(before.subagents);
      const run = before.runs[0]!;
      assert.equal(run.status, "preparing");
      const preparation = before.turnItems.find((item) => item.type === "command_execution")!;
      assert.equal(preparation.status, "running");
      assert.isEmpty((yield* orchestrator.getThreadShell(threadId))!.pendingBackgroundTasks);

      const archive = {
        type: "thread.archive" as const,
        commandId: CommandId.make("archive-preparing-archive"),
        threadId,
      };
      const archivedResult = yield* orchestrator.dispatch(archive);
      assert.equal((yield* orchestrator.dispatch(archive)).sequence, archivedResult.sequence);

      const assertCancelled = Effect.gen(function* () {
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const cancelledRun = projection.runs.find((candidate) => candidate.id === run.id)!;
        assert.equal(cancelledRun.status, "cancelled");
        assert.isNull(cancelledRun.queuePosition);
        assert.isNotNull(cancelledRun.completedAt);
        assert.equal(projection.attempts[0]?.status, "cancelled");
        assert.isNotNull(projection.attempts[0]?.completedAt);
        assert.equal(projection.nodes[0]?.status, "cancelled");
        assert.isNotNull(projection.nodes[0]?.completedAt);
        const item = projection.turnItems.find((candidate) => candidate.id === preparation.id)!;
        assert.equal(item.status, "cancelled");
        assert.equal(item.title, "Workspace preparation cancelled");
        assert.deepEqual(item.completedAt, cancelledRun.completedAt);
        assert.deepEqual(item.updatedAt, cancelledRun.completedAt);
        assert.isEmpty((yield* orchestrator.getThreadShell(threadId))!.pendingBackgroundTasks);
        assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.archivedAt);
      yield* assertCancelled;
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* assertCancelled;

      // Late preparation callbacks must not revive archived runs, even after reopen.
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("archive-preparing-unarchive"),
        threadId,
      });
      for (const callback of [
        { type: "prepared-run.progress", phase: "setup" },
        { type: "prepared-run.release" },
        {
          type: "prepared-run.fail",
          failure: {
            class: "validation_error",
            message: "Late preparation failure",
            code: null,
            retryable: false,
          },
        },
      ] as const) {
        const error = yield* orchestrator
          .dispatch({
            ...callback,
            commandId: CommandId.make(`archive-preparing-late:${callback.type}`),
            threadId,
            runId: run.id,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
      }
      yield* assertCancelled;
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* assertCancelled;
    }),
  );
  it.effect.each([false, true])(
    "promotes only one queued run after each terminal run (notification: %s)",
    (automatic) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-serialized-queue-thread-${automatic}`);

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-serialized-queue-create-${automatic}`),
          threadId,
          projectId: ProjectId.make(`runtime-layer-serialized-queue-project-${automatic}`),
          title: "Serialized queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-serialized-queue-active-${automatic}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-serialized-queue-active-${automatic}`),
          text: "Active",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: automatic ? "agent" : "user",
          creationSource: automatic ? "provider" : "web",
          ...(automatic
            ? {
                notification: {
                  source: { kind: "monitor" as const },
                  outcome: "updated" as const,
                  summary: "Monitor updated",
                  detail: "Build is green",
                },
              }
            : {}),
          commandId: CommandId.make(`runtime-layer-serialized-queue-first-${automatic}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-serialized-queue-first-${automatic}`),
          text: "First queued",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-serialized-queue-second-${automatic}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-serialized-queue-second-${automatic}`),
          text: "Second queued",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });

        const before = yield* orchestrator.getThreadProjection(threadId);
        const activeRun = before.runs.find((run) => run.status === "starting");
        const queuedRuns = before.runs
          .filter((run) => run.status === "queued")
          .toSorted((left, right) => left.ordinal - right.ordinal);
        const firstQueuedRun = queuedRuns[0];
        const secondQueuedRun = queuedRuns[1];
        assert.isDefined(activeRun);
        assert.isDefined(firstQueuedRun);
        assert.isDefined(secondQueuedRun);
        assert.isFalse(
          before.turnItems.some(
            (item) =>
              item.type === "user_message" &&
              (item.messageId === firstQueuedRun.userMessageId ||
                item.messageId === secondQueuedRun.userMessageId),
          ),
          "queued messages must not exist as turn items before dispatch",
        );

        const promotedRunIds = yield* Queue.unbounded<RunId>();
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting"
              ? Queue.offer(promotedRunIds, stored.event.payload.id)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const activeCompletedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`runtime-layer-serialized-queue-active-completed-${automatic}`),
              type: "run.updated",
              threadId,
              runId: activeRun.id,
              ...(activeRun.rootNodeId === null ? {} : { nodeId: activeRun.rootNodeId }),
              providerInstanceId: activeRun.providerInstanceId,
              occurredAt: activeCompletedAt,
              payload: {
                ...activeRun,
                status: "completed",
                completedAt: activeCompletedAt,
              },
            },
          ],
        });

        assert.equal(yield* Queue.take(promotedRunIds), firstQueuedRun.id);
        const afterFirstPromotion = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
          "starting",
        );
        assert.equal(
          afterFirstPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
          "queued",
        );
        const promotedMessageItem = afterFirstPromotion.turnItems.find(
          (item) =>
            item.runId === firstQueuedRun.id &&
            (item.type === "user_message" || item.type === "notification"),
        );
        assert.isDefined(promotedMessageItem);
        if (automatic) {
          assert.equal(promotedMessageItem.type, "notification");
          assert.equal(
            afterFirstPromotion.messages.find(
              (message) => message.id === firstQueuedRun.userMessageId,
            )?.text,
            "First queued",
          );
          assert.equal(
            afterFirstPromotion.messages.find(
              (message) => message.id === firstQueuedRun.userMessageId,
            )?.notification?.summary,
            "Monitor updated",
          );
          assert.isFalse(
            afterFirstPromotion.turnItems.some(
              (item) =>
                item.type === "user_message" && item.messageId === firstQueuedRun.userMessageId,
            ),
          );
        } else {
          assert.equal(promotedMessageItem.type, "user_message");
        }
        assert.isTrue(
          promotedMessageItem.startedAt !== null &&
            DateTime.toEpochMillis(promotedMessageItem.startedAt) >=
              DateTime.toEpochMillis(activeCompletedAt),
        );

        const promotedFirst = afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id);
        assert.isDefined(promotedFirst);
        const firstCompletedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`runtime-layer-serialized-queue-first-completed-${automatic}`),
              type: "run.updated",
              threadId,
              runId: promotedFirst.id,
              ...(promotedFirst.rootNodeId === null ? {} : { nodeId: promotedFirst.rootNodeId }),
              providerInstanceId: promotedFirst.providerInstanceId,
              occurredAt: firstCompletedAt,
              payload: {
                ...promotedFirst,
                status: "completed",
                completedAt: firstCompletedAt,
              },
            },
          ],
        });

        assert.equal(yield* Queue.take(promotedRunIds), secondQueuedRun.id);
        const afterSecondPromotion = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          afterSecondPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
          "completed",
        );
        assert.equal(
          afterSecondPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
          "starting",
        );
      }),
  );
  it.effect("starts a wake's work clock from the run that ran before it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-wake-work-start-thread");
      const messageId = (key: string) => MessageId.make(`runtime-layer-wake-work-start-${key}`);

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-wake-work-start-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-wake-work-start-project"),
        title: "Wake work start",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const dispatch = (key: string, wake: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: wake ? "agent" : "user",
          creationSource: wake ? "provider" : "web",
          ...(wake
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : {}),
          commandId: CommandId.make(`runtime-layer-wake-work-start-${key}`),
          threadId,
          messageId: messageId(key),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode:
            key === "prompt" ? { type: "start_immediately" } : { type: "queue_after_active" },
        });
      const runFor = (key: string) =>
        Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
          const run = runs.find((candidate) => candidate.userMessageId === messageId(key));
          assert.isDefined(run);
          return run;
        });
      yield* dispatch("prompt", false);
      yield* dispatch("queued", false);
      yield* dispatch("early-wake", true);
      yield* orchestrator.dispatch({
        type: "queued-run.reorder",
        commandId: CommandId.make("runtime-layer-wake-work-start-reorder"),
        threadId,
        runId: (yield* runFor("queued")).id,
        beforeRunId: null,
      });
      yield* dispatch("late-wake", true);
      assert.isUndefined((yield* runFor("early-wake")).workStartedAt);

      const startedRunIds = yield* Queue.unbounded<RunId>();
      const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting"
            ? Queue.offer(startedRunIds, stored.event.payload.id)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const now = yield* DateTime.now;
      const settle = (key: string, startedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const run = yield* runFor(key);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`runtime-layer-wake-work-start-${key}-completed`),
                type: "run.updated",
                threadId,
                runId: run.id,
                ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: startedAt,
                payload: { ...run, status: "completed", startedAt, completedAt: startedAt },
              },
            ],
          });
        });
      const millis = (value: DateTime.Utc | undefined) =>
        value === undefined ? undefined : DateTime.toEpochMillis(value);

      yield* settle("prompt", now);
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("early-wake")).id);
      assert.equal(millis((yield* runFor("early-wake")).workStartedAt), millis(now));

      yield* settle("early-wake", DateTime.add(now, { seconds: 1 }));
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("queued")).id);
      assert.isUndefined((yield* runFor("queued")).workStartedAt);

      const queuedStartedAt = DateTime.add(now, { minutes: 10 });
      yield* settle("queued", queuedStartedAt);
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("late-wake")).id);
      assert.equal(millis((yield* runFor("late-wake")).workStartedAt), millis(queuedStartedAt));

      const ordinals = yield* Effect.forEach(
        ["prompt", "early-wake", "queued", "late-wake"],
        (key) => Effect.map(runFor(key), (run) => run.ordinal),
      );
      assert.deepEqual(
        ordinals,
        ordinals.toSorted((left, right) => left - right),
      );
    }),
  );
});
