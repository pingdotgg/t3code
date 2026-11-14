// @effect-diagnostics effectFnOpportunity:off -- extracted phases keep the parent's arrow style
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
import { modelSelection } from "./runtimeLayer-fixtures.testkit.ts";

export const queueTestThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make(`${threadId}:project`),
      title: "Dispatcher",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
    });
    const send = (key: string, createdBy: "user" | "agent", start: boolean) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        createdBy,
        creationSource: createdBy === "user" ? "web" : "server",
        commandId: CommandId.make(`${threadId}:message:${key}`),
        threadId,
        messageId: MessageId.make(`${threadId}:message:${key}`),
        text: key,
        attachments: [],
        modelSelection,
        dispatchMode: { type: start ? "start_immediately" : "queue_after_active" },
      });
    const runFor = (key: string) =>
      Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
        const run = runs.find(
          (candidate) => candidate.userMessageId === MessageId.make(`${threadId}:message:${key}`),
        );
        assert.isDefined(run);
        return run;
      });
    const startedRunIds = yield* Queue.unbounded<RunId>();
    // Run updates in commit order; the run-update listener handles them in this order too.
    const runUpdates: Array<OrchestrationV2Run> = [];
    yield* eventSink
      .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
      .pipe(
        Stream.runForEach((stored) => {
          if (stored.event.type !== "run.updated") return Effect.void;
          runUpdates.push(stored.event.payload);
          return stored.event.payload.status === "starting"
            ? Queue.offer(startedRunIds, stored.event.payload.id)
            : Effect.void;
        }),
        Effect.forkScoped,
      );
    yield* Effect.yieldNow;
    const releasedAfter = (key: string, completedKey: string) =>
      Effect.gen(function* () {
        const [run, completed] = [yield* runFor(key), yield* runFor(completedKey)];
        const released = runUpdates.findIndex(
          (update) => update.id === run.id && update.queueHeld === false,
        );
        const completion = runUpdates.findIndex(
          (update) => update.id === completed.id && update.status === "completed",
        );
        assert.isAbove(released, completion, `${key} was released before ${completedKey} ended`);
      });
    const end = (
      key: string,
      status: "completed" | "failed",
      revision = "",
      patch: Partial<OrchestrationV2Run> = {},
    ) =>
      Effect.gen(function* () {
        const run = yield* runFor(key);
        assert.isNotNull(run.rootNodeId);
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            ...(status === "failed"
              ? [
                  {
                    id: EventId.make(`${threadId}:${key}:error`),
                    type: "turn-item.updated" as const,
                    threadId,
                    runId: run.id,
                    nodeId: run.rootNodeId,
                    providerInstanceId: run.providerInstanceId,
                    occurredAt: now,
                    payload: {
                      id: TurnItemId.make(`${threadId}:${key}:error`),
                      type: "error" as const,
                      threadId,
                      runId: run.id,
                      nodeId: run.rootNodeId,
                      providerThreadId: run.providerThreadId,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 2,
                      status: "failed" as const,
                      title: "Provider failure",
                      startedAt: now,
                      completedAt: now,
                      updatedAt: now,
                      failure: {
                        class: "provider_error" as const,
                        message: "Provider failed.",
                        code: "provider_failed",
                        retryable: null,
                      },
                    },
                  },
                ]
              : []),
            {
              id: EventId.make(`${threadId}:${key}:${status}${revision}`),
              type: "run.updated",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...run, ...patch, status, startedAt: now, completedAt: now },
            },
          ],
        });
      });

    // The run-update listener places failure holds after the terminal event commits.
    const awaitHeld = (key: string) =>
      Effect.gen(function* () {
        const run = yield* runFor(key);
        yield* eventSink.stream({ threadId, afterSequence: 0, eventType: "run.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === run.id &&
              stored.event.payload.queueHeld === true,
          ),
          Stream.runHead,
        );
      });
    return { send, runFor, end, startedRunIds, releasedAfter, awaitHeld };
  });

