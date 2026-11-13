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
  driver,
  layerTest,
  seedFailingRollbackThread,
  seedPendingQuestion,
} from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerTest)("OrchestrationV2LayerLive", (it) => {
  it.effect("projects a rollback that fails every attempt and clears it on the next one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const { threadId, rollback } = yield* seedFailingRollbackThread("runtime-rollback-failure");

      const rollbackCommandId = CommandId.make("runtime-rollback-failure-rollback");
      yield* rollback(rollbackCommandId);
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* worker.drain();
        yield* TestClock.adjust("30 seconds");
      }

      const [rollbackEffect] = yield* outbox.listByCommandId(rollbackCommandId);
      assert.equal(rollbackEffect?.status, "failed");
      const failed = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(failed.thread.rollbackFailure, {
        requestId: rollbackCommandId,
        message: ROLLBACK_FAILED_MESSAGE,
      });

      yield* rollback(CommandId.make("runtime-rollback-failure-retry"));
      const retried = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(retried.thread.rollbackFailure);
    }),
  );
  it.effect("rejects non-ready rollback targets before persisting events or effects", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("runtime-rollback-readiness");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-rollback-readiness-create"),
        threadId,
        projectId: ProjectId.make("runtime-rollback-readiness-project"),
        title: "Rollback readiness",
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
        commandId: CommandId.make("runtime-rollback-readiness-message"),
        threadId,
        messageId: MessageId.make("runtime-rollback-readiness-message"),
        text: "Create the provider thread and checkpoint scope.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const scope = projection.checkpointScopes[0]!;
      const now = yield* DateTime.now;

      for (const status of ["missing", "error", "stale", "ready"] as const) {
        const checkpointId = CheckpointId.make("runtime-rollback-checkpoint");
        const commandId = CommandId.make(`runtime-rollback-${status}`);
        yield* eventSink.write({
          commandId: CommandId.make(`runtime-rollback-${status}-seed`),
          events: [
            {
              id: EventId.make(`runtime-rollback-${status}-event`),
              type: "checkpoint.captured",
              threadId,
              occurredAt: now,
              payload: {
                id: checkpointId,
                threadId,
                scopeId: scope.id,
                runId: null,
                nodeId: scope.nodeId,
                parentCheckpointId: null,
                ordinalWithinScope: 0,
                appRunOrdinal: null,
                ref: CheckpointRef.make(`refs/t3/runtime-rollback-${status}`),
                status,
                files: [],
                capturedAt: now,
              },
            },
          ],
        });
        const previousSequence = yield* orchestrator.getThreadEventSequence(threadId);
        const rollback = orchestrator.dispatch({
          type: "checkpoint.rollback",
          commandId,
          threadId,
          checkpointId,
          scopeId: scope.id,
        });

        if (status === "ready") {
          const accepted = yield* rollback;
          assert.deepEqual(
            accepted.storedEvents.map((stored) => stored.event.type),
            ["thread.metadata-updated", "checkpoint.rollback-requested"],
          );
          assert.deepEqual(
            (yield* outbox.listByCommandId(commandId)).map((effect) => effect.request.type),
            ["provider-thread.rollback"],
          );
          const path = yield* Path.Path.pipe(
            Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("runtime-rollback-ancestor-create"),
            threadId: ThreadId.make("runtime-rollback-ancestor"),
            projectId: ProjectId.make("runtime-rollback-readiness-project"),
            title: "Ancestor workspace owner",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: path.dirname(process.cwd()),
          });
          const overlapCommandId = CommandId.make("runtime-rollback-overlap");
          const overlapSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const overlap = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: overlapCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
            })
            .pipe(Effect.flip);
          assert.match(String(overlap.cause), /isolated worktree/);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), overlapSequence);
          assert.deepEqual(yield* outbox.listByCommandId(overlapCommandId), []);
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("runtime-rollback-share"),
            threadId,
            worktreePath: null,
          });
          const sharedCommandId = CommandId.make("runtime-rollback-shared");
          const sequence = yield* orchestrator.getThreadEventSequence(threadId);
          const shared = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: sharedCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
            })
            .pipe(Effect.flip);
          assert.match(String(shared.cause), /isolated worktree/);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
          assert.deepEqual(yield* outbox.listByCommandId(sharedCommandId), []);
          const conversationOnly = yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make("runtime-rollback-conversation"),
            threadId,
            checkpointId,
            scopeId: scope.id,
            restoreFiles: false,
          });
          assert.deepEqual(
            conversationOnly.storedEvents.map((stored) => stored.event.type),
            ["thread.metadata-updated", "checkpoint.rollback-requested"],
          );
        } else {
          const error = yield* rollback.pipe(Effect.flip);
          assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
          assert.equal(
            error.cause,
            `Checkpoint ${checkpointId} is ${status} and cannot be restored.`,
          );
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), previousSequence);
          assert.deepEqual(
            yield* eventSink.readByCommandId({ commandId }).pipe(Stream.runCollect),
            [],
          );
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        }
      }
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );
  it.effect("resolves delivery intent against the active run and starts after it completes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const threadId = ThreadId.make("runtime-delivery-intent");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-delivery-intent-create"),
        threadId,
        projectId: ProjectId.make("runtime-delivery-intent-project"),
        title: "Delivery intent",
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
        commandId: CommandId.make("runtime-delivery-intent-first"),
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-first"),
        text: "Start work.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const run = initial.runs[0]!;
      const providerThread = initial.providerThreads[0]!;
      const now = yield* DateTime.now;
      const providerSession = {
        id: providerThread.providerSessionId!,
        driver,
        providerInstanceId: modelSelection.instanceId,
        status: "running" as const,
        cwd: process.cwd(),
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const providerTurn = {
        id: ProviderTurnId.make("runtime-delivery-intent-turn"),
        providerThreadId: providerThread.id,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* eventSink.write({
        commandId: CommandId.make("runtime-delivery-intent-running"),
        events: [
          {
            id: EventId.make("runtime-delivery-intent-run-event"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now },
          },
          {
            id: EventId.make("runtime-delivery-intent-session-event"),
            type: "provider-session.attached",
            threadId,
            occurredAt: now,
            payload: providerSession,
          },
          {
            id: EventId.make("runtime-delivery-intent-turn-event"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: providerTurn,
          },
        ],
      });
      const sessionSpy = vi.spyOn(sessions, "get").mockReturnValue(
        Effect.succeedSome({
          providerSession,
        } as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));

      const steerCommandId = CommandId.make("runtime-delivery-intent-auto");
      const steerMessageId = MessageId.make("runtime-delivery-intent-auto");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: steerCommandId,
        threadId,
        messageId: steerMessageId,
        text: "Include this in the active work.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "auto",
      });
      const steered = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(steered.runs, 1);
      assert.equal(
        steered.messages.find((message) => message.id === steerMessageId)?.runId,
        run.id,
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(steerCommandId)).map((effect) => effect.request),
        [
          {
            type: "provider-turn.steer",
            providerSessionId: providerSession.id,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            messageId: steerMessageId,
          },
        ],
      );

      yield* eventSink.write({
        commandId: CommandId.make("runtime-delivery-intent-completed"),
        events: [
          {
            id: EventId.make("runtime-delivery-intent-run-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
          {
            id: EventId.make("runtime-delivery-intent-turn-completed"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...providerTurn, status: "completed", completedAt: now },
          },
        ],
      });
      const nextCommandId = CommandId.make("runtime-delivery-intent-next");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: nextCommandId,
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-next"),
        text: "The previous run finished before this arrived.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "restart",
      });
      const restarted = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        restarted.runs.map((candidate) => candidate.status),
        ["completed", "starting"],
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(nextCommandId)).map((effect) => effect.request.type),
        ["provider-turn.start"],
      );
    }),
  );
  it.effect.each([
    { trigger: "startup", scope: "run" },
    { trigger: "shutdown", scope: "session" },
  ] as const)(
    "recovers only reconstructable user questions and keeps their cards pending on $trigger ($scope)",
    ({ trigger, scope }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`runtime-recovered-question-${trigger}-${scope}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`runtime-recovered-question-create-${trigger}-${scope}`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make(`runtime-recovered-question-project-${trigger}-${scope}`),
          title: "Async question",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        if (scope === "run") {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:run`),
            threadId,
            messageId: MessageId.make(`${threadId}:message`),
            text: "Ask me a question",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
        }
        const runId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.id ?? null;
        const { requestId, nodeId, itemId } = yield* seedPendingQuestion(threadId, runId, {
          type: "live",
          providerSessionId: ProviderSessionId.make(`lost-session-${trigger}-${scope}`),
        });
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const original = yield* orchestrator.getThreadProjection(threadId);
        const request = original.runtimeRequests[0]!;
        const questionItem = original.turnItems.find((item) => item.type === "user_input_request")!;
        const nativeThreadId = ThreadId.make(`runtime-recovered-native-child-${trigger}-${scope}`);
        const nativeRequestId = RuntimeRequestId.make(
          `runtime-recovered-native-request-${trigger}-${scope}`,
        );
        const approvalId = RuntimeRequestId.make(`runtime-recovered-approval-${trigger}-${scope}`);
        const missingTextId = RuntimeRequestId.make(
          `runtime-recovered-missing-text-${trigger}-${scope}`,
        );
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`recovery-approval-${trigger}-${scope}`),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: { ...request, id: approvalId, kind: "command" },
            },
            {
              id: EventId.make(`recovery-missing-text-${trigger}-${scope}`),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: { ...request, id: missingTextId },
            },
            {
              id: EventId.make(`recovery-native-thread-${trigger}-${scope}`),
              type: "thread.created",
              threadId: nativeThreadId,
              occurredAt: now,
              payload: {
                ...original.thread,
                id: nativeThreadId,
                creationSource: "provider",
                lineage: {
                  parentThreadId: threadId,
                  rootThreadId: threadId,
                  relationshipToParent: "subagent",
                },
              },
            },
            {
              id: EventId.make(`recovery-native-request-${trigger}-${scope}`),
              type: "runtime-request.updated",
              threadId: nativeThreadId,
              occurredAt: now,
              payload: { ...request, id: nativeRequestId },
            },
            {
              id: EventId.make(`recovery-native-item-${trigger}-${scope}`),
              type: "turn-item.updated",
              threadId: nativeThreadId,
              occurredAt: now,
              payload: {
                ...questionItem,
                id: TurnItemId.make(`recovery-native-item-${trigger}-${scope}`),
                type: "user_input_request",
                threadId: nativeThreadId,
                runId: null,
                requestId: nativeRequestId,
                questions: [
                  { id: "color", header: "Color", question: "Which color?", options: [] },
                ],
              },
            },
          ],
        });
        yield* recovery.reconcile(trigger);
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        if (scope === "run") {
          assert.equal(recovered.runs[0]?.status, "cancelled");
        } else {
          assert.isEmpty(recovered.runs);
        }
        assert.deepEqual(
          recovered.runtimeRequests.find((row) => row.id === requestId),
          {
            ...request,
            responseCapability: { type: "message" },
          },
        );
        assert.equal(recovered.nodes.find((row) => row.id === nodeId)?.status, "waiting");
        assert.equal(recovered.turnItems.find((row) => row.id === itemId)?.status, "waiting");
        for (const id of [approvalId, missingTextId]) {
          const closed = recovered.runtimeRequests.find((row) => row.id === id);
          assert.equal(closed?.status, trigger === "startup" ? "expired" : "cancelled");
          assert.equal(closed?.responseCapability.type, "not_resumable");
        }
        const native = yield* orchestrator.getThreadProjection(nativeThreadId);
        assert.equal(
          native.runtimeRequests[0]?.status,
          trigger === "startup" ? "expired" : "cancelled",
        );
        assert.equal(native.runtimeRequests[0]?.responseCapability.type, "not_resumable");
        yield* recovery.reconcile("shutdown");
        yield* recovery.reconcile("startup");
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests,
          recovered.runtimeRequests,
        );
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`recovery-answer-${trigger}-${scope}`),
          threadId,
          requestId,
          answers: { color: "Blue", sizes: ["Small", "Large"] },
        });
        const answered = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          answered.runtimeRequests.find((row) => row.id === requestId)?.status,
          "resolved",
        );
        assert.equal(answered.nodes.find((row) => row.id === nodeId)?.status, "completed");
        assert.equal(answered.turnItems.find((row) => row.id === itemId)?.status, "completed");
        assert.lengthOf(answered.runs, recovered.runs.length + 1);
        assert.equal(answered.messages.at(-1)?.runId, answered.runs.at(-1)?.id);
        assert.equal(
          answered.messages.at(-1)?.text,
          "Which color?\nBlue\n\nWhich sizes?\nSmall, Large",
        );
        assert.deepEqual(
          (yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
            CommandId.make(`recovery-answer-${trigger}-${scope}`),
          )).map((effect) => effect.request.type),
          ["provider-turn.start"],
        );
      }),
  );
  it.effect("answers an async question after its provider exits and commits the answer once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-async-question");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-async-question-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("runtime-async-question-project"),
        title: "Async question",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const { requestId, nodeId, itemId } = yield* seedPendingQuestion(threadId, null, {
        type: "message",
      });
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const beforeInvalid = yield* orchestrator.getThreadProjection(threadId);
      const beforeSequence = yield* eventSink.latestSequence();
      for (const [index, answers] of [
        { color: " ", sizes: ["Small"] },
        { color: "Blue", sizes: [] },
        { color: "Blue", sizes: ["Small", " "] },
        { color: "Blue", sizes: ["Small"], extra: " " },
      ].entries()) {
        const commandId = CommandId.make(`runtime-async-question-invalid:${index}`);
        const invalid = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId,
            threadId,
            requestId,
            answers,
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure", JSON.stringify(answers));
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), beforeInvalid);
        assert.equal(yield* eventSink.latestSequence(), beforeSequence);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }

      const command = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make("runtime-async-question-answer"),
        threadId,
        requestId,
        answers: { color: "  Blue  ", sizes: ["Small", "Large"], note: "" },
      };
      const accepted = yield* orchestrator.dispatch(command);
      const repeated = yield* orchestrator.dispatch(command);
      assert.equal(repeated.sequence, accepted.sequence);
      const answered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(answered.runtimeRequests[0]?.status, "resolved");
      assert.deepEqual(answered.runtimeRequests[0]?.answers, command.answers);
      assert.equal(answered.nodes.find((node) => node.id === nodeId)?.status, "completed");
      assert.equal(answered.turnItems.find((item) => item.id === itemId)?.status, "completed");
      const answeredItem = answered.turnItems.find((item) => item.id === itemId);
      assert.equal(answeredItem?.type, "user_input_request");
      if (answeredItem?.type === "user_input_request") {
        assert.deepEqual(answeredItem.questionAnswer, {
          requestId,
          answers: command.answers,
          attachmentsByQuestionId: {},
          questionTextById: {
            color: "Which color?",
            sizes: "Which sizes?",
            note: "Anything else?",
          },
        });
      }
      assert.equal(answered.messages.length, 1);
      assert.equal(answered.messages[0]?.text, "Which color?\nBlue\n\nWhich sizes?\nSmall, Large");
      assert.equal(answered.messages[0]?.role, "user");
      assert.equal(answered.runs.length, 1);
      assert.deepEqual(
        (yield* outbox.listByCommandId(command.commandId)).map((effect) => effect.request.type),
        ["provider-turn.start"],
      );

      const duplicate = yield* orchestrator
        .dispatch({
          ...command,
          commandId: CommandId.make("runtime-async-question-duplicate"),
        })
        .pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure");
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).messages.length, 1);
    }),
  );
});
