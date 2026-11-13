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

import {
  modelSelection,
  alternateInstanceId,
  driver,
  layerTest,
  queueTestThread,
  setup,
} from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect.each(["usage_limit", "provider_error"] as const)(
    "handles a queued message after a %s failure",
    (failureClass) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-failed-queue-${failureClass}`);

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Failed queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        for (const index of [0, 1]) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:${index}`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:${index}`),
            text: index === 0 ? "Active" : "Queued",
            attachments: [],
            modelSelection,
            dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
          });
        }

        const before = yield* orchestrator.getThreadProjection(threadId);
        const activeRun = before.runs.find((run) => run.status === "starting");
        const queuedRun = before.runs.find((run) => run.status === "queued");
        assert.isDefined(activeRun);
        assert.isDefined(queuedRun);
        assert.isNotNull(activeRun.rootNodeId);

        const promotedRunIds = yield* Queue.unbounded<RunId>();
        const heldRunIds = yield* Queue.unbounded<RunId>();
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type !== "run.updated"
              ? Effect.void
              : stored.event.payload.status === "starting"
                ? Queue.offer(promotedRunIds, stored.event.payload.id)
                : stored.event.payload.queueHeld === true
                  ? Queue.offer(heldRunIds, stored.event.payload.id)
                  : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:error`),
              type: "turn-item.updated",
              threadId,
              runId: activeRun.id,
              nodeId: activeRun.rootNodeId,
              providerInstanceId: activeRun.providerInstanceId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`${threadId}:error`),
                type: "error",
                threadId,
                runId: activeRun.id,
                nodeId: activeRun.rootNodeId,
                providerThreadId: activeRun.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "failed",
                title: "Provider failure",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: failureClass,
                  message: "Provider failed.",
                  code: "provider_failed",
                  retryable: null,
                  ...(failureClass === "usage_limit"
                    ? { resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })) }
                    : {}),
                },
              },
            },
            {
              id: EventId.make(`${threadId}:failed`),
              type: "run.updated",
              threadId,
              runId: activeRun.id,
              nodeId: activeRun.rootNodeId,
              providerInstanceId: activeRun.providerInstanceId,
              occurredAt: now,
              payload: { ...activeRun, status: "failed", completedAt: now },
            },
          ],
        });

        if (failureClass === "provider_error") {
          assert.equal(yield* Queue.take(heldRunIds), queuedRun.id);
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(held.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          });
          assert.equal(yield* Queue.take(promotedRunIds), queuedRun.id);
          return;
        }
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
        assert.isFalse(after.turnItems.some((item) => item.runId === queuedRun.id));
        const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        );
        assert.equal(shell?.latestRunId, activeRun.id);
        assert.equal(shell?.status, "failed");
        assert.equal(shell?.lastErrorClass, "usage_limit");
      }),
  );

  // A thread fed by agent messages, with helpers to end its runs as a provider would.
  it.effect("releases held agent messages once a later run completes, not the user's", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-failed-queue-agent-messages");
      const { send, runFor, end, startedRunIds, releasedAfter, awaitHeld } =
        yield* queueTestThread(threadId);
      yield* send("earlier", "agent", true);
      yield* end("earlier", "completed");
      yield* send("active", "agent", true);
      yield* send("issue", "agent", false);
      yield* send("user", "user", false);
      yield* end("active", "failed");
      yield* awaitHeld("issue");
      assert.isTrue((yield* runFor("issue")).queueHeld);
      // Delivery bookkeeping rewrites an older completed run; the thread has not moved on.
      yield* end("earlier", "completed", ":bookkeeping");
      // A scheduled tick finds the thread idle and starts past the held queue.
      yield* send("tick", "agent", true);
      assert.equal((yield* runFor("tick")).status, "starting");
      yield* end("tick", "completed");
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("issue")).id);
      yield* releasedAfter("issue", "tick");
      const user = yield* runFor("user");
      assert.equal(user.status, "queued");
      assert.isTrue(user.queueHeld);

      // A run that finishes despite a stop request does not release what the stop held.
      yield* send("after-stop", "agent", false);
      assert.isTrue((yield* runFor("after-stop")).queueHeld);
      const issue = yield* runFor("issue");
      assert.isNotNull(issue.rootNodeId);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:issue:interrupt-request`),
            type: "turn-item.updated",
            threadId,
            runId: issue.id,
            nodeId: issue.rootNodeId,
            providerInstanceId: issue.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:issue:interrupt-request`),
              type: "run_interrupt_request",
              threadId,
              runId: issue.id,
              nodeId: issue.rootNodeId,
              providerThreadId: issue.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "completed",
              title: "Interrupt requested",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              message: "Stopped by user",
            },
          },
        ],
      });
      yield* end("issue", "completed");
      // The next completed run releases it, which also shows the listener handled the stopped one.
      yield* send("probe", "agent", true);
      assert.equal((yield* runFor("probe")).status, "starting");
      yield* end("probe", "completed");
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("after-stop")).id);
      yield* releasedAfter("after-stop", "probe");
    }),
  );
  it.effect("keeps held agent messages while the thread's worktree setup is unresolved", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const dispatcherId = ThreadId.make("runtime-layer-held-queue-worktree");
      const dispatcher = yield* queueTestThread(dispatcherId);
      const witness = yield* queueTestThread(ThreadId.make("runtime-layer-held-queue-witness"));
      yield* dispatcher.send("setup", "agent", true);
      yield* dispatcher.send("issue", "agent", false);
      yield* dispatcher.end("setup", "failed", "", {
        workspacePreparation: { type: "worktree", baseRef: "main" },
      });
      yield* dispatcher.awaitHeld("issue");
      assert.isTrue((yield* dispatcher.runFor("issue")).queueHeld);
      yield* dispatcher.send("tick", "agent", true);
      assert.equal((yield* dispatcher.runFor("tick")).status, "starting");
      yield* witness.send("active", "agent", true);
      yield* witness.send("queued", "agent", false);
      // The failed setup never produced the thread's worktree.
      const { thread } = yield* orchestrator.getThreadProjection(dispatcherId);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${dispatcherId}:worktree-missing`),
            type: "thread.metadata-updated",
            threadId: dispatcherId,
            occurredAt: yield* DateTime.now,
            payload: { ...thread, worktreePath: null },
          },
        ],
      });
      yield* dispatcher.end("tick", "completed");
      // One listener handles every thread's completions in order, so the witness starting
      // means the tick's completion was handled too.
      yield* witness.end("active", "completed");
      assert.equal(yield* Queue.take(witness.startedRunIds), (yield* witness.runFor("queued")).id);
      assert.isTrue((yield* dispatcher.runFor("issue")).queueHeld);
    }),
  );
  it.effect("keeps queued user selections and pauses only the limited provider", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-queue-provider-limit");
      const queuedSelection = {
        instanceId: alternateInstanceId,
        model: "gpt-5.5",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        createdBy: "user",
        creationSource: "web",
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Limited queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const selections = [modelSelection, modelSelection, queuedSelection];
      for (const [index, selection] of selections.entries()) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:${index}`),
          text: `Prompt ${index}`,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          modelSelection: selection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      }
      const [active, limited, available] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(active);
      assert.isDefined(limited);
      assert.isDefined(available);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:error`),
            type: "turn-item.updated",
            threadId,
            runId: active.id,
            nodeId: active.rootNodeId!,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:error`),
              type: "error",
              threadId,
              runId: active.id,
              nodeId: active.rootNodeId!,
              providerThreadId: active.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Usage limit reached",
                code: "usage_limit",
                retryable: null,
              },
            },
          },
          {
            id: EventId.make(`${threadId}:failed`),
            type: "run.updated",
            threadId,
            runId: active.id,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: { ...active, status: "failed", completedAt: now },
          },
          {
            id: EventId.make(`${threadId}:other-session`),
            type: "provider-session.attached",
            threadId,
            providerInstanceId: alternateInstanceId,
            occurredAt: now,
            payload: {
              id: ProviderSessionId.make(`${threadId}:other-session`),
              driver,
              providerInstanceId: alternateInstanceId,
              status: "error",
              cwd: process.cwd(),
              model: queuedSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: "Unrelated session error on the other provider",
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${threadId}:select-other`),
        threadId,
        modelSelection: queuedSelection,
      });
      yield* orchestrator.resumeQueuedRuns;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.runs.find((run) => run.id === limited.id)?.status, "queued");
      const blocked = yield* orchestrator
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${threadId}:blocked`),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(blocked._tag, "OrchestratorDispatchError");

      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${threadId}:select-original`),
        threadId,
        modelSelection,
      });
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`${threadId}:cancel-limited`),
        threadId,
        runId: limited.id,
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:hold-available`),
            type: "run.updated",
            threadId,
            runId: available.id,
            occurredAt: now,
            payload: { ...available, queueHeld: true },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`${threadId}:resume-available`),
        threadId,
      });
      yield* orchestrator.resumeQueuedRuns;
      const after = yield* orchestrator.getThreadProjection(threadId);
      const started = after.runs.find((run) => run.id === available.id);
      assert.equal(started?.status, "starting");
      assert.deepEqual(started?.modelSelection, queuedSelection);
      assert.deepEqual(after.thread.modelSelection, queuedSelection);
    }),
  );
  it.effect.each([
    ["server", modelSelection],
    ["provider", modelSelection],
    ["provider", { ...modelSelection, instanceId: alternateInstanceId }],
  ] as const)(
    "delivers a queued monitor update from %s after conversation selection %j",
    ([creationSource, currentSelection]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(
          `runtime-layer-queue-current-conversation-${creationSource}-${currentSelection.instanceId}`,
        );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          createdBy: "user",
          creationSource: "web",
          title: "Current conversation",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        for (const type of ["start_immediately", "queue_after_active"] as const) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:${type}`),
            messageId: MessageId.make(`${threadId}:${type}`),
            threadId,
            text: type,
            attachments: [],
            createdBy: "agent",
            creationSource,
            dispatchMode: { type },
            ...(type === "queue_after_active"
              ? {
                  notification: {
                    source: { kind: "monitor" as const },
                    outcome: "updated" as const,
                    summary: "PR update",
                  },
                }
              : {}),
          });
        }
        const before = yield* orchestrator.getThreadProjection(threadId);
        const [active, queued] = before.runs;
        assert.isDefined(active);
        assert.isDefined(queued);
        const now = yield* DateTime.now;
        const current = {
          ...before.providerThreads[0]!,
          id: ProviderThreadId.make(`${threadId}:current`),
          updatedAt: now,
        };
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:select-current`),
          threadId,
          modelSelection: currentSelection,
        });
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:completed`),
              type: "run.updated",
              threadId,
              runId: active.id,
              occurredAt: now,
              payload: { ...active, status: "completed", completedAt: now },
            },
            {
              id: EventId.make(`${threadId}:conversation`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: current,
            },
          ],
        });
        const expectedThreadId =
          creationSource === "provider" ? queued.providerThreadId : current.id;
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const delivered = after.runs.find((run) => run.id === queued.id)!;
        assert.equal(delivered.status, "starting");
        assert.deepEqual(delivered.modelSelection, modelSelection);
        assert.equal(delivered.providerInstanceId, modelSelection.instanceId);
        assert.equal(
          after.attempts.find((attempt) => attempt.id === delivered.activeAttemptId)
            ?.providerInstanceId,
          modelSelection.instanceId,
        );
        assert.equal(delivered.providerThreadId, expectedThreadId);
        assert.equal(after.thread.activeProviderThreadId, expectedThreadId);
        assert.equal(
          after.attempts.find((attempt) => attempt.id === delivered.activeAttemptId)
            ?.providerThreadId,
          expectedThreadId,
        );
        const root = after.nodes.find((node) => node.id === delivered.rootNodeId)!;
        assert.equal(root.providerThreadId, expectedThreadId);
        assert.equal(
          after.checkpointScopes.find((scope) => scope.id === root.checkpointScopeId)
            ?.providerThreadId,
          expectedThreadId,
        );
      }),
  );
  it.effect.each([
    { ...modelSelection, model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] },
    { instanceId: alternateInstanceId, model: "gpt-5.5" },
  ])(
    "starts a queued delegated completion on a selection set while it waited: %j",
    (newerSelection) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(
          `runtime-layer-queued-delegated-completion-selection-${newerSelection.instanceId}`,
        );
        const taskId = NodeId.make(`${threadId}:task`);
        const completionMessageId = MessageId.make(`${threadId}:completion`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          createdBy: "user",
          creationSource: "web",
          title: "Delegated completion selection",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:active`),
          threadId,
          messageId: MessageId.make(`${threadId}:active`),
          text: "Delegate a task",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const active = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:cohort`),
              type: "run.updated",
              threadId,
              runId: active.id,
              occurredAt: now,
              payload: {
                ...active,
                delegatedCompletion: {
                  disposition: "open",
                  nextGeneration: 2,
                  delivery: { messageId: completionMessageId, generation: 1, taskIds: [taskId] },
                },
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:completion`),
          threadId,
          messageId: completionMessageId,
          text: "Delegated task finished",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: { parentRunId: active.id, generation: 1, taskIds: [taskId] },
        });
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:select-newer`),
          threadId,
          modelSelection: newerSelection,
        });
        const waiting = yield* orchestrator.getThreadProjection(threadId);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:completed`),
              type: "run.updated",
              threadId,
              runId: active.id,
              occurredAt: now,
              payload: {
                ...waiting.runs.find((run) => run.id === active.id)!,
                status: "completed",
                completedAt: now,
              },
            },
          ],
        });
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const delivered = after.runs.find((run) => run.userMessageId === completionMessageId)!;
        assert.equal(delivered.status, "starting");
        assert.deepEqual(delivered.modelSelection, newerSelection);
        assert.equal(
          after.attempts.find((attempt) => attempt.id === delivered.activeAttemptId)
            ?.providerInstanceId,
          newerSelection.instanceId,
        );
        assert.deepEqual(after.thread.modelSelection, newerSelection);
      }),
  );
});
