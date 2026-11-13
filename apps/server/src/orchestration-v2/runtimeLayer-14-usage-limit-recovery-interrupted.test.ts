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
  it.effect.each(["interrupted", "usage_limit"] as const)(
    "manually resumes an %s run ahead of its queued message only once",
    (reason) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const events = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`manual-resume:${reason}`);
        const projectId = ProjectId.make(`manual-resume:project:${reason}`);
        const now = yield* DateTime.now;
        const createdAt = DateTime.formatIso(now);
        yield* seedProject({
          projectId,
          title: "Resume project",
          workspaceRoot: process.cwd(),
          defaultModelSelection: modelSelection,
          createdAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`manual-resume:create:${reason}`),
          threadId,
          projectId,
          title: "Interrupted thread",
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
          commandId: CommandId.make(`manual-resume:start:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:start:${reason}`),
          text: "Start work.",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`manual-resume:queue:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:queue:${reason}`),
          text: "Follow up.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const [source, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
          OrchestrationV2Run,
          OrchestrationV2Run,
        ];
        // Hold the queue like user Stop so the terminal worker cannot start it before explicit resume.
        yield* events.write({
          events: [
            {
              id: EventId.make(`manual-resume:hold:${reason}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...queued, queueHeld: true },
            },
            {
              id: EventId.make(`manual-resume:stop:${reason}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...source,
                status: reason === "interrupted" ? "interrupted" : "failed",
                completedAt: now,
              },
            },
          ],
        });
        let scheduledResume: ReturnType<typeof limitRecoveryCommand> = null;
        if (reason === "usage_limit") {
          const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
          yield* events.write({
            events: [
              {
                id: EventId.make(`manual-resume:error:${reason}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`manual-resume:error:${reason}`),
                  type: "error",
                  threadId,
                  runId: source.id,
                  nodeId: source.rootNodeId,
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
          const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          )!;
          yield* orchestrator.dispatch(
            limitRecoveryCommand(shell, true, DateTime.toEpochMillis(now))!,
          );
          const armed = (yield* orchestrator.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          )!;
          scheduledResume = limitRecoveryCommand(armed, true, Date.parse(resetAt));
          assert.isNotNull(scheduledResume);
        }
        const resume = (suffix: string) => ({
          type: "message.dispatch" as const,
          commandId: CommandId.make(`manual-resume:${suffix}:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:${suffix}:${reason}`),
          manualContinuationOfRunId: source.id,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" as const },
          createdBy: "user" as const,
          creationSource: "web" as const,
        });
        yield* orchestrator.dispatch(resume("first"));
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(after.runs, 3);
        assert.equal(after.runs[1]?.status, "queued");
        assert.equal(after.runs[2]?.status, "starting");
        assert.equal(
          (yield* orchestrator.dispatch(resume("second")).pipe(Effect.exit))._tag,
          "Failure",
        );
        if (scheduledResume !== null) {
          yield* TestClock.adjust("1 minute");
          yield* orchestrator.dispatch(scheduledResume);
        }
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 3);
      }),
  );
});
