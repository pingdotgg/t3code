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
  layerTest,
  layerSharedApplicationDataPlaneTest,
  SCRATCH_ROOT,
  SCRATCH_PROJECT_ID,
  layerScratchPromotionTest,
  setup,
  shellOf,
} from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerSharedApplicationDataPlaneTest)("pending provider interruption", (it) => {
  it.effect("interrupts a pending provider start without launching provider work", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const projectId = ProjectId.make("runtime-layer-pending-interrupt-project");
      const threadId = ThreadId.make("runtime-layer-pending-interrupt-thread");

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-pending-interrupt-project-create"),
        projectId,
        title: "Pending interrupt project",
        workspaceRoot: "/tmp/runtime-layer-pending-interrupt-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-create"),
        threadId,
        projectId,
        title: "Pending interrupt",
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
        commandId: CommandId.make("runtime-layer-pending-interrupt-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-pending-interrupt-message"),
        text: "Do not reach the provider.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const starting = yield* orchestrator.getThreadProjection(threadId);
      const run = starting.runs[0];
      assert.isDefined(run);
      assert.equal(run.status, "starting");

      const interrupt = yield* threadManagement.interruptThread({
        projectId,
        commandId: CommandId.make("runtime-layer-pending-interrupt-command"),
        threadId,
        runId: run.id,
        reason: "Cancelled before provider start",
      });
      assert.equal(interrupt.type, "interrupt_requested");

      const interrupted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(interrupted.runs[0]?.status, "interrupted");
      assert.equal(interrupted.attempts[0]?.status, "interrupted");
      assert.equal(
        interrupted.nodes.find((node) => node.kind === "root_turn")?.status,
        "interrupted",
      );
      assert.deepEqual(
        interrupted.turnItems.filter((item) => item.runId === run.id).map((item) => item.type),
        ["user_message", "run_interrupt_request", "run_interrupt_result"],
      );
      assert.deepEqual(interrupted.providerTurns, []);
      assert.isFalse(yield* effectWorker.runOnce);
    }),
  );
});
it.layer(layerTest)("snooze queued runs", (it) => {
  it.effect.each(["notification", "delegated-completion", "user"] as const)(
    "only user messages block snooze with a held %s run",
    (kind) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`snooze-queued:${kind}`);
        const snoozedUntil = "2099-07-25T09:00:00.000Z";
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("snooze-queued-project"),
          title: "Snooze with held queued work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/snooze-queued",
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`active:${threadId}`),
          threadId,
          messageId: MessageId.make(`active:${threadId}`),
          text: "Active run",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const activeRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        if (kind === "delegated-completion") {
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`completion:${threadId}`),
                type: "run.updated",
                threadId,
                runId: activeRun.id,
                occurredAt: now,
                payload: {
                  ...activeRun,
                  delegatedCompletion: {
                    disposition: "open",
                    nextGeneration: 2,
                    delivery: {
                      messageId: MessageId.make(`queued:${threadId}`),
                      generation: 1,
                      taskIds: [NodeId.make("snooze-queued-task")],
                    },
                  },
                },
              },
            ],
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`queued:${threadId}`),
          threadId,
          messageId: MessageId.make(`queued:${threadId}`),
          text: "Queued work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: kind === "user" ? "user" : "agent",
          creationSource: kind === "user" ? "web" : "server",
          ...(kind === "notification"
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : kind === "delegated-completion"
              ? {
                  delegatedCompletion: {
                    parentRunId: activeRun.id,
                    generation: 1,
                    taskIds: [NodeId.make("snooze-queued-task")],
                  },
                }
              : {}),
        });
        const beforeRecovery = yield* orchestrator.getThreadProjection(threadId);
        yield* eventSink.commitCommand({
          commandId: CommandId.make(`recovery:${threadId}`),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: beforeRecovery.runs.map((run) => ({
            id: EventId.make(`recovery:${run.id}`),
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
        const beforeSnooze = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(beforeSnooze.runs.some((run) => run.status === "queued" && run.queueHeld));
        const snooze = orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`snooze:${threadId}`),
          threadId,
          snoozedUntil,
        });
        if (kind === "user") {
          const error = yield* snooze.pipe(Effect.flip);
          assert.equal(error._tag, "OrchestratorDispatchError");
          assert.equal(error.cause, `Thread ${threadId} has a queued run and cannot be snoozed.`);
          assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
        } else {
          yield* snooze;
          const snoozed = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(DateTime.formatIso(snoozed.thread.snoozedUntil!), snoozedUntil);
          assert.deepEqual(snoozed.runs, beforeSnooze.runs);
          yield* orchestrator.dispatch({
            type: "thread.unsnooze",
            commandId: CommandId.make(`unsnooze:${threadId}`),
            threadId,
            reason: "user",
          });
          const awake = yield* orchestrator.getThreadProjection(threadId);
          assert.isNull(awake.thread.snoozedUntil);
          assert.deepEqual(awake.runs, beforeSnooze.runs);
        }
      }),
  );

  it.effect.each(["notification", "user"] as const)(
    "a %s message on a snoozed thread keeps the snooze only when automatic",
    (kind) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`snooze-wake:${kind}`);
        const snoozedUntil = "2099-07-25T09:00:00.000Z";
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("snooze-wake-project"),
          title: "Snoozed long-running thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/snooze-wake",
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`snooze:${threadId}`),
          threadId,
          snoozedUntil,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`wake:${threadId}`),
          threadId,
          messageId: MessageId.make(`wake:${threadId}`),
          text: "Continue",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: kind === "user" ? "user" : "agent",
          creationSource: kind === "user" ? "web" : "provider",
          ...(kind === "notification"
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : {}),
        });
        const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
        if (kind === "user") {
          assert.isNull(thread.snoozedUntil);
        } else {
          assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
        }
      }),
  );
});
it.layer(layerScratchPromotionTest)("turning a No project thread into a project", (it) => {
  const setup = Effect.fn(function* (name: string) {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const folder = `${SCRATCH_ROOT}/2026-01-01-${name}`;
    if (Option.isNone(yield* projects.getById(SCRATCH_PROJECT_ID))) {
      yield* projects.create({
        commandId: CommandId.make("promotion-scratch-create"),
        projectId: SCRATCH_PROJECT_ID,
        title: "No project",
        workspaceRoot: SCRATCH_ROOT,
      });
    }
    const createThread = (suffix: string, worktreePath: string) =>
      orchestrator
        .dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`promotion-${name}-${suffix}-create`),
          threadId: ThreadId.make(`promotion-${name}-${suffix}`),
          projectId: SCRATCH_PROJECT_ID,
          title: `${name} ${suffix}`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath,
        })
        .pipe(Effect.as(ThreadId.make(`promotion-${name}-${suffix}`)));
    return { folder, createThread };
  });
  const shellOf = (threadId: ThreadId) =>
    Orchestrator.OrchestratorV2.pipe(
      Effect.flatMap((orchestrator) => orchestrator.getThreadShell(threadId)),
    );

  it.effect("moves every thread in the folder and its bound tasks into one project", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const { folder, createThread } = yield* setup("moves");
      const threadId = yield* createThread("main", folder);
      const siblingId = yield* createThread("sibling", folder);
      const otherId = yield* createThread("other", `${SCRATCH_ROOT}/2026-01-01-elsewhere`);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("promotion-moves-sibling-archive"),
        threadId: siblingId,
      });
      const { task } = yield* tasks.upsert({
        id: ScheduledTaskId.make("promotion-moves-bound"),
        title: "Bound",
        prompt: "Check in",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: SCRATCH_PROJECT_ID,
        threadId: siblingId,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      });

      const { projectId } = yield* promotion.promote({ threadId });

      const project = yield* projects.getById(projectId);
      assert.equal(Option.getOrUndefined(project)?.workspaceRoot, folder);
      assert.equal(Option.getOrUndefined(project)?.title, "moves main");
      for (const id of [threadId, siblingId]) {
        const shell = yield* shellOf(id);
        assert.equal(shell?.projectId, projectId);
        assert.isNull(shell?.worktreePath);
      }
      assert.equal((yield* shellOf(otherId))?.projectId, SCRATCH_PROJECT_ID);
      const saved = (yield* tasks.list()).tasks.find((candidate) => candidate.id === task.id);
      assert.equal(saved?.projectId, projectId);
      assert.deepEqual(yield* promotion.promote({ threadId }), { projectId });
    }),
  );

  it.effect("changes nothing while a thread in the folder is busy", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { folder, createThread } = yield* setup("busy");
      const threadId = yield* createThread("idle", folder);
      const busyId = yield* createThread("delegate", folder);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("promotion-busy-message"),
        threadId: busyId,
        messageId: MessageId.make("promotion-busy-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const error = yield* promotion.promote({ threadId }).pipe(Effect.flip);

      assert.equal(error.message, '"busy delegate" is still working. Finish or stop it first.');
      assert.isTrue(Option.isNone(yield* projects.getByWorkspaceRoot(folder)));
      assert.equal((yield* shellOf(threadId))?.projectId, SCRATCH_PROJECT_ID);
    }),
  );

  it.effect("finishes a partial move from either thread", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { folder, createThread } = yield* setup("partial");
      const movedId = yield* createThread("moved", folder);
      const leftId = yield* createThread("left", folder);
      const earlier = yield* projects.create({
        commandId: CommandId.make("promotion-partial-project"),
        projectId: ProjectId.make("promotion-partial-project"),
        title: "Earlier",
        workspaceRoot: folder,
      });
      yield* orchestrator.dispatch({
        type: "thread.project.adopt-folder",
        commandId: CommandId.make("promotion-partial-adopt"),
        threadId: movedId,
        projectId: earlier.id,
      });

      assert.deepEqual(yield* promotion.promote({ threadId: movedId }), { projectId: earlier.id });
      assert.equal((yield* shellOf(leftId))?.projectId, earlier.id);
    }),
  );

  it.effect("refuses a thread outside No project", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("promotion-regular-project");
      const threadId = ThreadId.make("promotion-regular-thread");
      yield* projects.create({
        commandId: CommandId.make("promotion-regular-project"),
        projectId,
        title: "Regular",
        workspaceRoot: "/tmp/runtime-layer-promotion-regular",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("promotion-regular-thread-create"),
        threadId,
        projectId,
        title: "Regular",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const error = yield* promotion.promote({ threadId }).pipe(Effect.flip);

      assert.equal(
        error.message,
        "Only a No project thread with its own folder can become a project.",
      );
    }),
  );
});
it.layer(layerSharedApplicationDataPlaneTest)("snooze projection", (it) => {
  it.effect("carries snooze, settle and title state through the V2 shell projection", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-snoozed-project");
      const threadId = ThreadId.make("runtime-layer-snoozed-thread");
      const snoozedUntil = "2099-07-25T09:00:00.000Z";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-snoozed-project-create"),
        projectId,
        title: "Snoozed shell projection",
        workspaceRoot: "/tmp/runtime-layer-snoozed-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-thread-create"),
        threadId,
        projectId,
        title: "Snoozed thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze"),
        threadId,
        snoozedUntil,
      });

      const firstProjection = yield* orchestrator.getThreadProjection(threadId);
      const firstSnoozedAt = firstProjection.thread.snoozedAt;
      assert.isNotNull(firstSnoozedAt);

      // Restamp snoozedAt for identical wake times so previously waking failures do not keep the thread awake.
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-again"),
        threadId,
        snoozedUntil,
      });

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
      assert.equal(
        DateTime.toEpochMillis(thread.snoozedAt!),
        DateTime.toEpochMillis(firstSnoozedAt!) + 1_000,
      );
      assert.deepEqual(thread.updatedAt, thread.snoozedAt);

      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-wake"),
        threadId,
        reason: "user",
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(ProjectionStore.layer),
      );
      const [candidate] = yield* projections.getSettlementCandidates(threadId);
      assert.deepEqual(candidate?.lastSnoozeWakeAt, yield* DateTime.now);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-snoozed-thread-settle"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-after-wake"),
        threadId,
        snoozedUntil,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-snoozed-message"),
        text: "Wake this thread.",
        titleSeed: "Woken thread",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const awakened = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awakened.thread.snoozedUntil);
      assert.isNull(awakened.thread.snoozedAt);
      assert.isNull(awakened.thread.settledOverride);
      assert.isNull(awakened.thread.settledAt);
      assert.equal(awakened.thread.title, "Woken thread");
      assert.equal(
        awakened.thread.titleRegeneration?.requestId,
        CommandId.make("runtime-layer-snoozed-message"),
      );
    }),
  );

  it.effect("moves a thread into a project rooted at its own folder", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const scratchProjectId = ProjectId.make("runtime-layer-adopt-scratch");
      const folderProjectId = ProjectId.make("runtime-layer-adopt-folder");
      const otherProjectId = ProjectId.make("runtime-layer-adopt-other");
      const folder = "/tmp/runtime-layer-adopt-scratch/2026-01-01-notes-a1b2c3d4";
      const createProject = (projectId: ProjectId, workspaceRoot: string) =>
        projects.create({
          commandId: CommandId.make(`${projectId}-create`),
          projectId,
          title: projectId,
          workspaceRoot,
        });
      const createThread = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}-create`),
          threadId,
          projectId: scratchProjectId,
          title: "Scratch work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: folder,
        });
      const adopt = (threadId: ThreadId, projectId: ProjectId, suffix: string) =>
        orchestrator.dispatch({
          type: "thread.project.adopt-folder",
          commandId: CommandId.make(`${threadId}-adopt-${suffix}`),
          threadId,
          projectId,
        });
      yield* createProject(scratchProjectId, "/tmp/runtime-layer-adopt-scratch");
      yield* createProject(folderProjectId, folder);
      yield* createProject(otherProjectId, "/tmp/runtime-layer-adopt-other");
      const idleThreadId = ThreadId.make("runtime-layer-adopt-idle");
      const busyThreadId = ThreadId.make("runtime-layer-adopt-busy");
      yield* createThread(idleThreadId);
      yield* createThread(busyThreadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-adopt-busy-message"),
        threadId: busyThreadId,
        messageId: MessageId.make("runtime-layer-adopt-busy-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const otherFolder = yield* adopt(idleThreadId, otherProjectId, "other").pipe(Effect.flip);
      assert.equal(
        otherFolder.cause,
        `Thread ${idleThreadId} does not work in /tmp/runtime-layer-adopt-other.`,
      );
      const missing = yield* adopt(idleThreadId, ProjectId.make("missing"), "missing").pipe(
        Effect.flip,
      );
      assert.equal(missing.cause, `Thread ${idleThreadId} cannot move to missing project missing.`);
      const busy = yield* adopt(busyThreadId, folderProjectId, "busy").pipe(Effect.flip);
      assert.equal(
        busy.cause,
        `Thread ${busyThreadId} still has work in progress. Finish or stop it first.`,
      );

      yield* adopt(idleThreadId, folderProjectId, "folder");
      const shell = yield* orchestrator.getShellSnapshot();
      const moved = shell.threads.find((thread) => thread.id === idleThreadId);
      assert.equal(moved?.projectId, folderProjectId);
      assert.isNull(moved?.worktreePath);
      const stayed = shell.threads.find((thread) => thread.id === busyThreadId);
      assert.equal(stayed?.projectId, scratchProjectId);
    }),
  );
});
