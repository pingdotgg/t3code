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
  watchedPullRequestDetail,
  seedProject,
  layerTest,
} from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect.each([
    "single page",
    "paginated",
    "page failure",
    "repeated cursor",
    "missing comments",
    "thread list truncated",
  ])("wakes a watched thread once: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`runtime-pull-request-watch-wake-${mode}`);
      const projectId = ProjectId.make(`pr-watch-wake-project-${mode}`);
      yield* seedProject({
        projectId,
        title: "Watch wake",
        workspaceRoot: "/workspace/watch",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-wake-create-${mode}`),
        threadId,
        projectId,
        title: "Watch wake",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
      const url = "https://github.com/pingdotgg/t3code/pull/7";
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`pr-watch-wake-link-${mode}`),
        threadId,
        ...key,
        url,
        source: "agent",
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`pr-watch-wake-start-${mode}`),
        threadId,
        ...key,
        watching: true,
      });

      const at = "2026-10-02T12:00:00.000Z";
      const detail = watchedPullRequestDetail({ projectId, number: key.number, at });
      const initialWatch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.isDefined(initialWatch);
      const remark: PullRequestComment = {
        id: "review-1",
        kind: "review-comment",
        author: { login: "reviewer", name: null, avatarUrl: null },
        body: "One more thing.",
        createdAt: "2999-01-01T00:00:03.000Z",
        url: null,
        path: "src/index.ts",
        reviewState: null,
      };
      const firstTen = Array.from({ length: 10 }, (_, index) => ({
        ...remark,
        id: `old-${index}`,
        createdAt: "1900-01-01T00:00:00.000Z",
      }));
      const eleventh = {
        ...remark,
        id: "reply-11",
        body: "Eleventh reply.",
        createdAt: "2999-01-01T00:00:01.000Z",
      };
      const twelfth = {
        ...remark,
        id: "reply-12",
        body: "Twelfth reply.",
        createdAt: "2999-01-01T00:00:02.000Z",
      };
      const incomplete = mode !== "single page" && mode !== "paginated";
      let recovering = false;
      let pagesRead = 0;
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () => Effect.succeed(detail),
              activity: () =>
                Effect.succeed({
                  comments:
                    mode === "single page"
                      ? [remark]
                      : [...firstTen, { ...remark, kind: "issue-comment" }],
                  commentCount: mode === "single page" ? 1 : 13,
                  commentsTruncated: mode !== "single page",
                  reviewThreadsTruncated: mode === "thread list truncated" && !recovering,
                  reviewThreads:
                    mode === "single page"
                      ? []
                      : [
                          {
                            id: "review-thread",
                            path: "src/index.ts",
                            line: 1,
                            side: "right",
                            isResolved: false,
                            isOutdated: false,
                            comments: firstTen,
                            commentCount: 12,
                            nextCommentsCursor: "after-10",
                          },
                        ],
                  commits: [],
                }),
              threadComments: (input) => {
                pagesRead += 1;
                assert.equal(input.threadId, "review-thread");
                if (input.cursor === "after-10") {
                  return Effect.succeed({ comments: [eleventh], nextCursor: "after-11" });
                }
                assert.equal(input.cursor, "after-11");
                if (!recovering && mode === "page failure") {
                  return Effect.fail(
                    new PullRequestOperationError({
                      operation: "threadComments",
                      detail: "Page unavailable",
                    }),
                  );
                }
                if (!recovering && mode === "repeated cursor") {
                  return Effect.succeed({ comments: [eleventh], nextCursor: "after-11" });
                }
                if (!recovering && mode === "missing comments") {
                  return Effect.succeed({ comments: [], nextCursor: null });
                }
                return Effect.succeed({ comments: [eleventh, twelfth], nextCursor: null });
              },
            }),
          ),
        ),
      );
      if (incomplete) {
        yield* reactor.sweep;
        const held = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
        assert.equal(held?.remarksThrough, initialWatch?.remarksThrough);
        assert.deepEqual(held?.remarkIds, initialWatch?.remarkIds);
        assert.deepEqual(held?.failedChecks, ["lint"]);
        const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
        assert.deepEqual(
          messages.map((message) => message.notification?.summary),
          ["#7: checks failed"],
        );
        yield* TestClock.adjust("1 millis");
        recovering = true;
      }
      yield* reactor.sweep;
      const pagesBefore = pagesRead;
      yield* reactor.sweep;
      assert.equal(pagesRead, pagesBefore);

      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(
        messages.flatMap((message) =>
          message.notification === undefined ? [] : [message.notification.summary],
        ),
        incomplete
          ? ["#7: checks failed", "#7: new comments"]
          : ["#7: checks failed, new comments"],
      );
      if (mode !== "single page") {
        const wake = messages.at(-1);
        assert.include(wake?.text ?? "", "3 new comments");
        assert.include(wake?.text ?? "", "Eleventh reply.");
        assert.include(wake?.text ?? "", "Twelfth reply.");
      }
      const watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.equal(watch?.remarksThrough, remark.createdAt);
      assert.deepEqual(watch?.remarkIds, [remark.id]);
      assert.deepEqual(
        { headSha: watch?.headSha, failedChecks: watch?.failedChecks, wakes: watch?.wakes },
        { headSha: "abc1234def", failedChecks: ["lint"], wakes: incomplete ? 1 : 0 },
      );
    }),
  );
  it.effect("persists rejected command receipts across retries", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("runtime-layer-rejected-command"),
        threadId: ThreadId.make("runtime-layer-missing-thread"),
      };

      const first = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      const retry = yield* orchestrator.dispatch(command).pipe(Effect.flip);

      assert.equal(first._tag, "OrchestratorProjectionError");
      assert.equal(retry._tag, "OrchestratorCommandPreviouslyRejectedError");
    }),
  );
  it.effect(
    "admits restart continuations once and rejects a stale continuation behind newer work",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("runtime-layer-restart-continuation");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("restart-create"),
          threadId,
          projectId: ProjectId.make("restart-project"),
          title: "Restart",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/runtime-layer-restart",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("restart-user-message"),
          threadId,
          messageId: MessageId.make("restart-user-message"),
          text: "Original work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* eventSink.commitCommand({
          commandId: CommandId.make("restart-cancel"),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: [
            {
              id: EventId.make("restart-cancel-event"),
              type: "run.updated",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: { ...original, status: "cancelled", completedAt: now },
            },
            {
              id: EventId.make("restart-cut-wake-event"),
              type: "run.created",
              threadId,
              runId: RunId.make("restart-cut-wake"),
              occurredAt: now,
              payload: {
                ...original,
                id: RunId.make("restart-cut-wake"),
                ordinal: 2,
                status: "cancelled",
                startedAt: null,
                completedAt: now,
              },
            },
          ],
          effects: [],
        });
        const command = {
          type: "message.dispatch" as const,
          createdBy: "agent" as const,
          creationSource: "server" as const,
          commandId: CommandId.make("restart-automatic-message"),
          threadId,
          messageId: MessageId.make("restart-automatic-message"),
          text: "Continue where you left off.",
          notification: {
            source: { kind: "system" as const },
            outcome: "updated" as const,
            summary: "T3 Code restarted and resumed this turn",
            detail: "Continue where you left off.",
          },
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" as const },
          restartContinuationOfRunId: original.id,
        };
        yield* orchestrator.dispatch(command);
        yield* orchestrator.dispatch(command);
        const admitted = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(admitted.runs, 3);
        assert.equal(admitted.runs[2]?.restartContinuationOfRunId, original.id);
        const continuationItems = admitted.turnItems.filter(
          (item) => item.runId === admitted.runs[2]?.id,
        );
        assert.isFalse(continuationItems.some((item) => item.type === "user_message"));
        assert.deepInclude(
          continuationItems.flatMap((item) =>
            item.type === "notification" ? [[item.summary, item.detail]] : [],
          ),
          ["T3 Code restarted and resumed this turn", "Continue where you left off."],
        );
        yield* orchestrator.dispatch({
          ...command,
          commandId: CommandId.make("restart-stale-race"),
          messageId: MessageId.make("restart-stale-race"),
        });
        const raced = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(raced.runs, 3);
        assert.isFalse(raced.messages.some((message) => message.id === "restart-stale-race"));
      }),
  );
  it.effect.each([
    ["failed", "shell", false],
    ["completed", "shell", false],
    ["waiting", "shell", false],
    ["cancelled", "shell", false],
    ["completed", "watchdog-monitor", false],
    ["failed", "awaited-monitor", false],
    ["completed", "awaited-monitor", true],
    ["waiting", "awaited-monitor", true],
    ["cancelled", "awaited-monitor", true],
  ] as const)(
    "admits a restart continuation of a %s run that lost a %s: %s",
    ([status, kind, admitted]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-restart-${status}-${kind}-source`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`restart-${status}-${kind}-create`),
          threadId,
          projectId: ProjectId.make("restart-project"),
          title: "Restart",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/runtime-layer-restart-failed",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`restart-${status}-${kind}-user-message`),
          threadId,
          messageId: MessageId.make(`restart-${status}-${kind}-user-message`),
          text: "Original work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* eventSink.commitCommand({
          commandId: CommandId.make(`restart-${status}-${kind}-reconcile`),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: [
            {
              id: EventId.make(`restart-${status}-${kind}-run`),
              type: "run.updated",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: { ...original, status, completedAt: now },
            },
            {
              id: EventId.make(`restart-${status}-${kind}-work`),
              type: "run.background-work-cancelled",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: {
                runId: original.id,
                restartCancelledBackgroundWork: [
                  kind === "shell"
                    ? { kind, label: "sleep 25" }
                    : {
                        kind: "monitor",
                        label: "sleep 25",
                        ...(kind === "awaited-monitor" ? { awaited: true as const } : {}),
                      },
                ],
              },
            },
          ],
          effects: [],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make(`restart-${status}-${kind}-continuation`),
          threadId,
          messageId: MessageId.make(`restart-${status}-${kind}-continuation`),
          text: "Note: the T3 server restarted.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          restartContinuationOfRunId: original.id,
        });
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, status);
        assert.deepEqual(
          projection.runs.slice(1).map((run) => run.restartContinuationOfRunId),
          admitted ? [original.id] : [],
        );
      }),
  );
  it.effect("rejects settling a thread while a run is active", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-active-settle-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-active-settle-project"),
        title: "Active settle",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-active-settle",
      });
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-active-settle-initial"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-active-settle-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const nonEmptyClaim = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-active-settle-empty-claim"),
          threadId,
          worktreePath: "/tmp/reassigned-after-message",
          expectedEmpty: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(nonEmptyClaim, Orchestrator.OrchestratorDispatchError);

      const error = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("runtime-layer-active-settle"),
          threadId,
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(error.cause, `Thread ${threadId} is still running. Stop it before settling.`);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.isNull(projection.thread.settledOverride);
      assert.isNull(projection.thread.settledAt);
      assert.isNotNull(projection.thread.unsettledAt);
    }),
  );
  it.effect("settles a thread its own agent settled once the turn completes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-settle-after-run-project");
      const threadId = ThreadId.make("runtime-layer-settle-after-run-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-after-run-create"),
        threadId,
        projectId,
        title: "Settle after run",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-settle-after-run",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-after-run-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-settle-after-run-message"),
        text: "Fix it and then settle this thread.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
      if (run === undefined) return yield* Effect.die(new Error("Run missing."));

      const settled = yield* orchestrator
        .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "thread.settled" })
        .pipe(Stream.runHead, Effect.forkChild);
      const result = yield* threadManagement.settleThread({
        threadId,
        commandId: CommandId.make("runtime-layer-settle-after-run-settle"),
        byOwnAgent: true,
      });
      assert.deepEqual(result, { settlesWhenTurnEnds: true });
      assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-settle-after-run-completed"),
        events: [
          {
            id: EventId.make("runtime-layer-settle-after-run-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* Fiber.join(settled);

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.settledOverride, "settled");
    }),
  );
});
