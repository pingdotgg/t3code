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

import { modelSelection, layerTest } from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("keeps the queue after a user interrupts the active run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-interrupted-queue");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Interrupted queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      for (const [index, text] of ["Active", "Queued"].entries()) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = before.runs[0]!;
      const queuedRun = before.runs[1]!;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:interrupt`),
        threadId,
        runId: activeRun.id,
        holdQueue: true,
      });

      yield* orchestrator.resumeQueuedRuns;
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === activeRun.id)?.status, "interrupted");
      assert.equal(after.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
      assert.isTrue(after.runs.find((run) => run.id === queuedRun.id)?.queueHeld);
      assert.isFalse(after.turnItems.some((item) => item.runId === queuedRun.id));
    }),
  );
  it.effect("places held queued messages after a continuation that started first", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-continuation-before-queue");
      const messageId = (key: string) => MessageId.make(`${threadId}:${key}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Continuation before queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const dispatch = (key: string, start: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:${key}`),
          threadId,
          messageId: messageId(key),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode: { type: start ? "start_immediately" : "queue_after_active" },
        });
      const runFor = (key: string) =>
        Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
          const run = runs.find((candidate) => candidate.userMessageId === messageId(key));
          assert.isDefined(run);
          return run;
        });
      yield* dispatch("active", true);
      yield* dispatch("first-queued", false);
      yield* dispatch("second-queued", false);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:interrupt`),
        threadId,
        runId: (yield* runFor("active")).id,
        holdQueue: true,
      });
      yield* dispatch("continue", true);
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`${threadId}:resume`),
        threadId,
      });

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
      const complete = (key: string) =>
        Effect.gen(function* () {
          const run = yield* runFor(key);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${threadId}:${key}:completed`),
                type: "run.updated",
                threadId,
                runId: run.id,
                ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...run, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
        });

      yield* complete("continue");
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("first-queued")).id);
      yield* complete("first-queued");
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("second-queued")).id);

      const keys = ["active", "continue", "first-queued", "second-queued"];
      const runs = yield* Effect.forEach(keys, runFor);
      const ordinals = runs.map((run) => run.ordinal);
      assert.deepEqual(
        ordinals,
        ordinals.toSorted((left, right) => left - right),
      );
      const { turnItems } = yield* orchestrator.getThreadProjection(threadId);
      const userItems = turnItems.filter((item) => item.type === "user_message");
      assert.deepEqual(
        userItems.map((item) => item.messageId),
        keys.map(messageId),
      );
    }),
  );
  it.effect.each([false, true])(
    "restarts a continuation that failed before its prompt, unless stopped (%s)",
    (stopped) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(`runtime-layer-continuation-start-retry-${stopped}`);
        const messageId = (key: string) => MessageId.make(`${threadId}:${key}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Continuation start retry",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const runFor = (key: string) =>
          Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) =>
            runs.find((candidate) => candidate.userMessageId === messageId(key)),
          );
        const write = (
          key: string,
          payload: OrchestrationV2Run,
          extra: Parameters<typeof eventSink.write>[0]["events"] = [],
        ) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                ...extra,
                {
                  id: EventId.make(`${threadId}:${key}`),
                  type: "run.updated",
                  threadId,
                  runId: payload.id,
                  providerInstanceId: payload.providerInstanceId,
                  occurredAt: now,
                  payload: { ...payload, startedAt: now, completedAt: now },
                },
              ],
            });
          });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:cut`),
          threadId,
          messageId: messageId("cut"),
          text: "Work that the restart cut",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const cut = (yield* runFor("cut"))!;
        yield* write("cut:cancelled", { ...cut, status: "cancelled" });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make(`${threadId}:message:continuation`),
          threadId,
          messageId: messageId("continuation"),
          text: "Continue where you left off.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          restartContinuationOfRunId: cut.id,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:queued`),
          threadId,
          messageId: messageId("queued"),
          text: "Queued behind the continuation",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
        const continuation = (yield* runFor("continuation"))!;
        assert.isNotNull(continuation.rootNodeId);
        const queued = (yield* runFor("queued"))!;
        // The failure holds the queue after the reactor scheduled any retry.
        const held = yield* eventSink
          .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queued.id &&
                stored.event.payload.queueHeld === true,
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
        yield* Effect.yieldNow;
        const now = yield* DateTime.now;
        yield* write("continuation:failed", { ...continuation, status: "failed" }, [
          {
            id: EventId.make(`${threadId}:continuation:error`),
            type: "turn-item.updated",
            threadId,
            runId: continuation.id,
            nodeId: continuation.rootNodeId,
            providerInstanceId: continuation.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:continuation:error`),
              type: "error",
              threadId,
              runId: continuation.id,
              nodeId: continuation.rootNodeId,
              providerThreadId: continuation.providerThreadId,
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
                class: "provider_error",
                message: "Claude timed out while registering its MCP tools.",
                code: null,
                retryable: null,
              },
            },
          },
        ]);
        yield* Fiber.join(held);
        const retriesOf = Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) =>
          runs.filter((run) => run.restartContinuationOfRunId === continuation.id),
        );
        yield* worker.drain();
        assert.deepEqual(yield* retriesOf, [], "the retry waits out its backoff");
        if (stopped) {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`${threadId}:stop`),
            threadId,
          });
        }
        yield* TestClock.adjust("61 seconds");
        yield* worker.drain();
        assert.lengthOf(yield* retriesOf, stopped ? 0 : 1);
      }),
  );
  it.effect.each(["startup", "shutdown"] as const)(
    "preserves and holds queued messages across %s until explicitly resumed",
    (trigger) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const threadId = ThreadId.make(`queue-hold-${trigger}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Recover queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        for (const [index, text] of ["Active", "First queued", "Second queued"].entries()) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:${index}`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:${index}`),
            text,
            attachments: [],
            modelSelection,
            dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
          });
        }
        const before = yield* orchestrator.getThreadProjection(threadId);
        const queued = before.runs.filter((run) => run.status === "queued");
        assert.equal(queued.length, 2);
        yield* recovery.reconcile(trigger);
        yield* recovery.reconcile("startup");
        const maintenance = yield* ProjectionReplay.ProjectionReplay;
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          held.runs.map((run) => run.status),
          ["cancelled", "queued", "queued"],
        );
        for (const run of queued) {
          assert.deepEqual(
            held.runs.find((row) => row.id === run.id),
            { ...run, queueHeld: true },
          );
          assert.deepEqual(
            held.messages.find((row) => row.id === run.userMessageId),
            before.messages.find((row) => row.id === run.userMessageId),
          );
          assert.equal(
            held.attempts.find((row) => row.id === run.activeAttemptId)?.status,
            "pending",
          );
          assert.equal(held.nodes.find((row) => row.id === run.rootNodeId)?.status, "pending");
        }
        const first = queued[0]!;
        const second = queued[1]!;
        yield* orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make(`${threadId}:edit`),
          threadId,
          runId: second.id,
          text: "Edited second message",
        });
        yield* orchestrator.dispatch({
          type: "queued-run.reorder",
          commandId: CommandId.make(`${threadId}:reorder`),
          threadId,
          runId: second.id,
          beforeRunId: first.id,
        });
        assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
        const resume = {
          type: "queue.resume" as const,
          commandId: CommandId.make(`${threadId}:resume`),
          threadId,
        };
        yield* orchestrator.dispatch(resume);
        yield* orchestrator.dispatch(resume);
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(resumed.runs.find((run) => run.id === second.id)?.status, "starting");
        assert.equal(resumed.runs.find((run) => run.id === first.id)?.status, "queued");
        assert.isFalse(resumed.runs.some((run) => run.status === "queued" && run.queueHeld));
        assert.equal(
          resumed.messages.find((row) => row.id === second.userMessageId)?.text,
          "Edited second message",
        );
        assert.equal(resumed.runs.length, 3, "resume retries must not duplicate messages or runs");
      }),
  );
  it.effect("starts a provider wake queued beside a held queue", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("queue-hold-provider-wake");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Wake beside a held queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const send = (index: number, text: string, source: "web" | "provider" | "server" = "web") =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: source === "web" ? "user" : "agent",
          creationSource: source,
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      yield* send(0, "Active");
      yield* send(1, "Queued before the restart");
      yield* recovery.reconcile("startup");
      yield* send(2, "First background task completed.", "provider");
      yield* send(3, "Background task completed.", "provider");
      yield* send(4, "Continue after the command completed.", "server");
      const queued = yield* orchestrator.getThreadProjection(threadId);
      const [held, active, wake] = [queued.runs[1]!, queued.runs[2]!, queued.runs[3]!];
      assert.equal(active.status, "starting");
      assert.isTrue(held.queueHeld);
      assert.equal(wake.status, "queued");
      assert.notEqual(wake.queueHeld, true);
      const textContinuation = queued.runs[4]!;
      assert.isTrue(textContinuation.queueHeld);
      const now = yield* DateTime.now;
      yield* events.write({
        events: [
          {
            id: EventId.make(`${threadId}:active-done`),
            type: "run.updated",
            threadId,
            runId: active.id,
            occurredAt: now,
            payload: { ...active, status: "completed", completedAt: now },
          },
        ],
      });
      yield* orchestrator.resumeQueuedRuns;
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === wake.id)?.status, "starting");
      assert.deepEqual(
        after.runs.find((run) => run.id === held.id),
        held,
      );
      // Nobody will resume a server message, so the completed run released it behind the wake.
      assert.deepEqual(
        after.runs.find((run) => run.id === textContinuation.id),
        { ...textContinuation, queueHeld: false },
      );
    }),
  );
  it.effect("edits and removes queued runs", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-queued-edit-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-queued-edit-project"),
        title: "Edit queued work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-queued-edit",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-active-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-active-message"),
        text: "Keep the provider occupied.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-queued-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-queued-message"),
        text: "Original queued text.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const before = yield* orchestrator.getThreadProjection(threadId);
      const queuedRun = before.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);

      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-edit"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text.",
      });

      const afterEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterEdit.messages.find((message) => message.id === queuedRun.userMessageId)?.text,
        "Updated queued text.",
      );
      const editedItem = afterEdit.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === queuedRun.userMessageId,
      );
      assert.isUndefined(editedItem, "editing queue state must not create a timeline turn item");

      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-attachments"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text with an attachment.",
        attachments: [
          {
            type: "image",
            id: "runtime-layer-queued-edit-attachment",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      });
      const afterAttachmentEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        afterAttachmentEdit.messages
          .find((message) => message.id === queuedRun.userMessageId)
          ?.attachments.map((attachment) => attachment.id),
        ["runtime-layer-queued-edit-attachment"],
      );

      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-text-only"),
        threadId,
        runId: queuedRun.id,
        text: "Text-only edit keeps attachments.",
      });
      const afterTextOnlyEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        afterTextOnlyEdit.messages
          .find((message) => message.id === queuedRun.userMessageId)
          ?.attachments.map((attachment) => attachment.id),
        ["runtime-layer-queued-edit-attachment"],
        "an edit without attachments must leave the stored attachments untouched",
      );

      const emptyEditError = yield* orchestrator
        .dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("runtime-layer-queued-edit-empty"),
          threadId,
          runId: queuedRun.id,
          text: "   ",
        })
        .pipe(Effect.flip);
      assert.equal(emptyEditError._tag, "OrchestratorCommandRejectedError");

      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("runtime-layer-queued-edit-cancel"),
        threadId,
        runId: queuedRun.id,
      });

      const afterCancel = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterCancel.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
      assert.equal(
        afterCancel.attempts.find((attempt) => attempt.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.equal(
        afterCancel.nodes.find((node) => node.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.isFalse(
        afterCancel.visibleTurnItems.some(
          (row) => row.item.type === "user_message" && row.item.runId === queuedRun.id,
        ),
        "removed queued message must not surface as a transcript row",
      );
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);

      const cancelAgainError = yield* orchestrator
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("runtime-layer-queued-edit-cancel-again"),
          threadId,
          runId: queuedRun.id,
        })
        .pipe(Effect.flip);
      assert.equal(cancelAgainError._tag, "OrchestratorDispatchError");
    }),
  );
});
