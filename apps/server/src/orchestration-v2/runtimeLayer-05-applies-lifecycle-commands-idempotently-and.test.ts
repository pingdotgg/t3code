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
  seedProject,
  moveProject,
  layerTest,
  shellOf,
} from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("applies lifecycle commands idempotently and emits archive/removal shell deltas", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-lifecycle-thread");
      const projectId = ProjectId.make("runtime-layer-lifecycle-project");
      const project = {
        projectId,
        title: "Lifecycle project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        createdAt: "2026-09-07T00:00:00.000Z",
      } as const;
      yield* seedProject(project);
      const create = {
        type: "thread.create" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
        commandId: CommandId.make("runtime-layer-lifecycle-create"),
        threadId,
        projectId,
        title: "Lifecycle thread",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
      };

      const firstCreate = yield* orchestrator.dispatch(create);
      const retriedCreate = yield* orchestrator.dispatch(create);
      assert.equal(retriedCreate.sequence, firstCreate.sequence);
      assert.lengthOf(retriedCreate.storedEvents, 1);

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-lifecycle-metadata"),
        threadId,
        title: "Renamed lifecycle thread",
        branch: "feature/v2",
        worktreePath: "/tmp/t3-v2-worktree",
      });
      const staleWorkspaceUpdate = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-lifecycle-stale-workspace"),
          threadId,
          branch: "feature/stale",
          worktreePath: "/tmp/stale-worktree",
          expectedWorktreePath: null,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleWorkspaceUpdate, Orchestrator.OrchestratorDispatchError);
      const projectionAfterStaleWorkspaceUpdate = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projectionAfterStaleWorkspaceUpdate.thread.branch, "feature/v2");
      assert.equal(projectionAfterStaleWorkspaceUpdate.thread.worktreePath, "/tmp/t3-v2-worktree");
      const pullRequestSnapshot = yield* orchestrator.getShellSnapshot();
      const pullRequest = {
        projectId,
        repository: "owner/repository",
        number: 24,
        url: "https://github.com/owner/repository/pull/24",
      };
      yield* moveProject(projectId, "/workspace/moved", "2026-09-07T00:01:00.000Z");
      const staleProjectWorkspace = yield* orchestrator
        .dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("runtime-layer-lifecycle-pr-sync-stale-project-workspace"),
          threadId,
          projectId,
          snapshotSequence: pullRequestSnapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/project",
            branch: "feature/v2",
            worktreePath: "/tmp/t3-v2-worktree",
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: pullRequest,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleProjectWorkspace, Orchestrator.OrchestratorDispatchError);
      yield* moveProject(projectId, project.workspaceRoot, "2026-09-07T00:02:00.000Z");
      yield* orchestrator.dispatch({
        type: "thread.pull-request.sync",
        commandId: CommandId.make("runtime-layer-lifecycle-pr-sync"),
        threadId,
        projectId,
        snapshotSequence: pullRequestSnapshot.snapshotSequence,
        expected: {
          workspaceRoot: "/workspace/project",
          branch: "feature/v2",
          worktreePath: "/tmp/t3-v2-worktree",
          linkedPullRequest: null,
          branchPullRequest: null,
        },
        branchPullRequest: pullRequest,
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.branchPullRequest,
        pullRequest,
      );
      const stalePullRequestSync = yield* orchestrator
        .dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("runtime-layer-lifecycle-pr-sync-stale"),
          threadId,
          projectId,
          snapshotSequence: pullRequestSnapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/project",
            branch: "feature/v2",
            worktreePath: "/tmp/t3-v2-worktree",
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: null,
        })
        .pipe(Effect.flip);
      assert.instanceOf(stalePullRequestSync, Orchestrator.OrchestratorDispatchError);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-runtime"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-interaction"),
        threadId,
        interactionMode: "plan",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("runtime-layer-lifecycle-model"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-5.5" },
      });
      yield* orchestrator.dispatch({
        type: "thread.active.reorder",
        commandId: CommandId.make("runtime-layer-lifecycle-active-order"),
        threadId,
        orderKey: "a0",
      });
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.activeOrderKey, "a0");

      const shellOf = (shell: Pick<OrchestrationV2ShellSnapshot, "threads">) =>
        shell.threads.find((thread) => thread.id === threadId)!;
      const untaggedShell = shellOf(yield* orchestrator.getShellSnapshot());
      yield* TestClock.adjust("1 minute");
      for (const [step, tag, tagged, expected] of [
        ["add", "demo", true, ["demo"]],
        ["retry", "demo", true, ["demo"]],
        ["add-other", "private", true, ["demo", "private"]],
        ["remove", "demo", false, ["private"]],
        ["remove-last", "private", false, []],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.tag.set",
          commandId: CommandId.make(`runtime-layer-lifecycle-tag-${step}`),
          threadId,
          tag,
          tagged,
        });
        assert.deepEqual(
          shellOf(yield* orchestrator.getShellSnapshot()).tags ?? [],
          expected,
          step,
        );
      }
      const taggedShell = shellOf(yield* orchestrator.getShellSnapshot());
      // Tags are not activity, so the thread keeps its place in thread lists.
      assert.equal(
        DateTime.toEpochMillis(taggedShell.updatedAt),
        DateTime.toEpochMillis(untaggedShell.updatedAt),
      );

      const preAutoProjection = yield* orchestrator.getThreadProjection(threadId);
      const staleAutoSettle = yield* orchestrator
        .dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("runtime-layer-lifecycle-auto-settle-stale"),
          threadId,
          snapshotAt: DateTime.makeUnsafe(
            DateTime.toEpochMillis(preAutoProjection.thread.updatedAt) - 1,
          ),
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleAutoSettle, Orchestrator.OrchestratorDispatchError);
      yield* orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("runtime-layer-lifecycle-auto-settle"),
        threadId,
        snapshotAt: preAutoProjection.thread.updatedAt,
      });
      const autoSettledProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(autoSettledProjection.thread.settledOverride, "settled");
      assert.isNull(autoSettledProjection.thread.activeOrderKey);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("runtime-layer-lifecycle-auto-unsettle"),
        threadId,
        reason: "user",
      });
      const postUnsettleProjection = yield* orchestrator.getThreadProjection(threadId);
      const overriddenAutoSettle = yield* orchestrator
        .dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("runtime-layer-lifecycle-auto-settle-overridden"),
          threadId,
          snapshotAt: postUnsettleProjection.thread.updatedAt,
        })
        .pipe(Effect.flip);
      assert.instanceOf(overriddenAutoSettle, Orchestrator.OrchestratorDispatchError);

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-lifecycle-settle"),
        threadId,
      });
      const settledProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(settledProjection.thread.settledOverride, "settled");
      assert.isNotNull(settledProjection.thread.settledAt);

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("runtime-layer-lifecycle-unsettle"),
        threadId,
        reason: "user",
      });
      const activeProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(activeProjection.thread.settledOverride, "active");
      assert.isNull(activeProjection.thread.settledAt);
      assert.isNotNull(activeProjection.thread.unsettledAt);
      const activeShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepEqual(activeShell?.unsettledAt, activeProjection.thread.unsettledAt);

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-lifecycle-resettle"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("runtime-layer-lifecycle-pin-settled"),
        threadId,
      });
      const pinnedProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(pinnedProjection.thread.settledOverride, "active");
      assert.isNotNull(pinnedProjection.thread.unsettledAt);

      const archive = yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-lifecycle-archive"),
        threadId,
      });
      const archivedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        archivedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.include(
        archivedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      const activeOnlyShell = yield* orchestrator.getShellSnapshot({ location: "active" });
      assert.notInclude(
        activeOnlyShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.lengthOf(activeOnlyShell.archivedThreads, 0);
      const archiveOnlyShell = yield* orchestrator.getShellSnapshot({ location: "archive" });
      assert.lengthOf(archiveOnlyShell.threads, 0);
      assert.include(
        archiveOnlyShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: archive.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.removed",
          sequence: archive.sequence,
          location: "active",
          threadId,
        },
      );

      const remove = yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("runtime-layer-lifecycle-delete"),
        threadId,
      });
      const deletedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        deletedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.notInclude(
        deletedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: remove.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.removed",
          sequence: remove.sequence,
          location: "active",
          threadId,
        },
      );

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed lifecycle thread");
      assert.equal(projection.thread.branch, "feature/v2");
      assert.equal(projection.thread.worktreePath, "/tmp/t3-v2-worktree");
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.equal(projection.thread.modelSelection.model, "gpt-5.5");
      assert.isNotNull(projection.thread.archivedAt);
      assert.isNotNull(projection.thread.deletedAt);
    }),
  );
  it.effect("keeps the branch pull request when linking another pull request", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("branch-pr-link");
      const projectId = ProjectId.make("branch-pr-project");
      yield* seedProject({
        projectId,
        title: "PR links",
        workspaceRoot: "/workspace/pr-links",
        defaultModelSelection: null,
        createdAt: "2026-09-17T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("branch-pr-create"),
        threadId,
        projectId,
        title: "PR links",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/pr-links",
        worktreePath: null,
      });
      const snapshot = yield* orchestrator.getShellSnapshot();
      yield* orchestrator.dispatch({
        type: "thread.pull-request.sync",
        commandId: CommandId.make("branch-pr-discover"),
        threadId,
        projectId,
        snapshotSequence: snapshot.snapshotSequence,
        expected: {
          workspaceRoot: "/workspace/pr-links",
          branch: "feature/pr-links",
          worktreePath: null,
          linkedPullRequest: null,
          branchPullRequest: null,
        },
        branchPullRequest: {
          projectId,
          repository: "pingdotgg/t3code",
          number: 1,
          url: "https://github.com/pingdotgg/t3code/pull/1",
        },
      });
      for (const [index, number] of [2, 2, 1, 3].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`branch-pr-link-${index}`),
          threadId,
          host: "GitHub.com",
          repository: "Pingdotgg/T3code",
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: "manual",
        });
        assert.deepEqual(
          (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
          number === 3 ? [1, 2, 3] : [1, 2],
        );
      }
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("branch-pr-unlink"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 1,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("branch-pr-link-after-unlink"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 4,
        url: "https://github.com/pingdotgg/t3code/pull/4",
        source: "manual",
      });
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
        [2, 3, 4],
      );
      for (const [index, route] of ["pull", "pulls"].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`gitcafe-pr-link-${index}`),
          threadId,
          host: "git.cafe",
          repository: "pingdotgg/t3code",
          number: 21353 + index,
          url: `https://git.cafe/pingdotgg/t3code/${route}/${21353 + index}`,
          source: "manual",
        });
      }
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests
          ?.filter((link) => link.host === "git.cafe")
          .map((link) => link.url),
        [21353, 21354].map((number) => `https://git.cafe/pingdotgg/t3code/pulls/${number}`),
      );
    }),
  );
  it.effect("retains multiple pull requests and dismissed stack members through rebuilds", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-multiple-pull-requests");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("multi-pr-create"),
        threadId,
        projectId: ProjectId.make("multi-pr-project"),
        title: "Stack",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "GitHub.com", repository: "Pingdotgg/T3code" };
      for (const number of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`multi-pr-link-${number}`),
          threadId,
          ...key,
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: number === 1 ? "manual" : "stack",
        });
      }
      const linked = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(
        linked?.pullRequests?.map(({ host, repository, number }) => ({ host, repository, number })),
        [1, 2].map((number) => ({ host: "github.com", repository: "pingdotgg/t3code", number })),
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("multi-pr-dismiss"),
        threadId,
        ...key,
        number: 2,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("multi-pr-unlink"),
        threadId,
        ...key,
        number: 1,
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map(({ number, source }) => ({
          number,
          source,
        })),
        [{ number: 2, source: "stack-dismissed" }],
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("multi-pr-rediscover"),
        threadId,
        ...key,
        number: 2,
        url: "https://github.com/pingdotgg/t3code/pull/2",
        source: "stack",
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "stack-dismissed",
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "stack-dismissed",
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("multi-pr-restore"),
        threadId,
        ...key,
        number: 2,
        url: "https://github.com/pingdotgg/t3code/pull/2",
        source: "manual",
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "manual",
      );
    }),
  );
  it.effect("starts, records, and stops a pull request watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-pull-request-watch");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-project"),
        title: "Watch",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
      const url = "https://github.com/pingdotgg/t3code/pull/7";
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-start"),
        threadId,
        ...key,
        watching: true,
        link: { url, source: "agent" },
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "agent",
      );
      const started = yield* watchOf;
      assert.isDefined(started);
      if (started === undefined) return;

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("pr-watch-legacy-relink"),
        threadId,
        linkedPullRequest: { projectId: ProjectId.make("pr-watch-project"), ...key, url },
      });
      assert.deepEqual(yield* watchOf, started);

      const recorded = { ...started, headSha: "abc123", failedChecks: ["lint"], wakes: 1 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-record"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: recorded,
      });
      assert.deepEqual(yield* watchOf, recorded);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* watchOf, recorded);

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-stop"),
        threadId,
        ...key,
        watching: false,
      });
      const late = yield* orchestrator
        .dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make("pr-watch-late-record"),
          threadId,
          ...key,
          startedAt: started.startedAt,
          watch: { ...recorded, wakes: 2 },
          wake: {
            messageId: MessageId.make("pr-watch-late-wake"),
            text: "Update",
            notification: { source: { kind: "monitor" }, outcome: "updated", summary: "#7" },
          },
        })
        .pipe(Effect.flip);
      assert.equal(late._tag, "OrchestratorDispatchError");
      assert.isUndefined(yield* watchOf);
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(messages, []);
    }),
  );
});
