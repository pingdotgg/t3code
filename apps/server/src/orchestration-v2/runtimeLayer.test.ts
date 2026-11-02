import { SourceControlProviderKind } from "@t3tools/contracts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
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
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
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

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-runtime-layer-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const alternateInstanceId = ProviderInstanceId.make("codex_alternate");

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.mock(GitWorkflow.GitWorkflowService)({
  pruneWorktrees: () => Effect.void,
  createWorktree: () => Effect.succeed({} as never),
});
const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const alternateProviderInstance = {
  ...providerInstance,
  instanceId: alternateInstanceId,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test:alternate",
  },
  displayName: "Codex alternate test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: alternateInstanceId,
  },
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(
        [providerInstance, alternateProviderInstance].find(
          (instance) => instanceId === instance.instanceId,
        ),
      ),
    listInstances: Effect.succeed([providerInstance, alternateProviderInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const watchedPullRequestDetail = (input: {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly at: string;
}): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    checksAlwaysReport: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: input.projectId,
  projectTitle: "Watch wake",
  workspaceRoot: "/workspace/watch",
  repository: "pingdotgg/t3code",
  number: input.number,
  title: "Watched pull request",
  body: "",
  url: `https://github.com/pingdotgg/t3code/pull/${input.number}`,
  author: { login: "agent-user", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: input.at,
  updatedAt: input.at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "failure", description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent-user",
});

const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

const moveProject = (projectId: ProjectId, workspaceRoot: string, updatedAt: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`move:${projectId}:${workspaceRoot}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: updatedAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.meta-updated",
      payload: { projectId, workspaceRoot, updatedAt },
    }),
  );

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const layerLegacyImportTest = RuntimeLayer.layer.pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const layerScheduledTasksTest = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Scheduler.layer,
    ),
  ),
);
const layerResourceCleanupTest = ResourceCleanupService.layer.pipe(
  Layer.provideMerge(layerScheduledTasksTest),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    ),
  ),
);

const layerProjectDeletionTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provideMerge(layerResourceCleanupTest),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerProjectDeletionTest)("project deletion during thread commands", (it) => {
  it.effect.each(["thread", "project"] as const)(
    "deleting a %s removes its thread-bound automations through the effect worker",
    (deletion) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const projectId = ProjectId.make(`automation-delete-project:${deletion}`);
        const threadId = ThreadId.make(`automation-delete-thread:${deletion}`);
        const otherThreadId = ThreadId.make(`automation-surviving-thread:${deletion}`);
        yield* projects.create({
          commandId: CommandId.make(`automation-create-project:${deletion}`),
          projectId,
          title: "Automation lifecycle",
          workspaceRoot: `/work/automation-lifecycle/${deletion}`,
        });
        for (const id of [threadId, otherThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`automation-create:${id}`),
            createdBy: "user",
            creationSource: "web",
            threadId: id,
            projectId: id === threadId ? projectId : ProjectId.make("automation-other-project"),
            title: "Automation target",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
        }
        const save = (name: string, target: ThreadId | null, webhook = false) =>
          tasks.upsert({
            id: ScheduledTaskId.make(`automation:${deletion}:${name}`),
            title: name,
            prompt: "Check orchestration progress",
            enabled: !webhook,
            schedule: webhook ? { type: "webhook" } : { type: "interval", everyMs: 60_000 },
            projectId,
            threadId: target,
            workspaceStrategy: { type: "root" },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
          });
        const { task: bound } = yield* save("bound", threadId);
        const { task: webhook } = yield* save("webhook", threadId, true);
        const { task: independent } = yield* save("independent", null);
        yield* save("detached", threadId);
        const { task: detached } = yield* save("detached", null);
        yield* save("moved", threadId);
        const { task: moved } = yield* save("moved", otherThreadId);
        const { task: other } = yield* save("other", otherThreadId);
        yield* tasks.triggerWebhook({
          hookId: webhook.id,
          token: webhook.webhook!.path.split("/").at(-1)!,
          method: "POST",
          path: webhook.webhook!.path,
          query: "",
          headers: {},
          body: new Uint8Array(),
          bodyText: "",
        });
        assert.lengthOf((yield* tasks.listWebhookDeliveries({ id: webhook.id })).deliveries, 1);

        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`automation-archive:${deletion}`),
          threadId,
        });
        yield* worker.drain();
        assert.include(
          (yield* tasks.list()).tasks.map((task) => task.id),
          bound.id,
        );

        if (deletion === "thread") {
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`automation-delete:${deletion}`),
            threadId,
          });
        } else {
          yield* projects.delete({
            commandId: CommandId.make(`automation-delete:${deletion}`),
            projectId,
            force: true,
          });
        }
        yield* worker.drain();
        const remainingIds = (yield* tasks.list()).tasks.map((task) => task.id);
        assert.notInclude(remainingIds, bound.id);
        assert.notInclude(remainingIds, webhook.id);
        assert.includeMembers(remainingIds, [independent.id, detached.id, moved.id, other.id]);
        assert.lengthOf((yield* tasks.listWebhookDeliveries({ id: webhook.id })).deliveries, 0);
        const rejected = yield* tasks.runNow({ id: bound.id }).pipe(Effect.flip);
        assert.equal(rejected.message, "Schedule task not found.");
        assert.equal(
          (yield* tasks.triggerWebhook({
            hookId: webhook.id,
            token: webhook.webhook!.path.split("/").at(-1)!,
            method: "POST",
            path: webhook.webhook!.path,
            query: "",
            headers: {},
            body: new Uint8Array(),
            bodyText: "",
          }))._tag,
          "not_found",
        );
        // Retried cleanup is harmless and cannot affect unrelated tasks.
        yield* tasks.deleteForThread(threadId);
        assert.sameMembers(
          (yield* tasks.list()).tasks.map((task) => task.id),
          remainingIds,
        );
      }),
  );

  it.effect("waits for an in-flight thread update before planning deletion", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-project-delete-concurrent");
      const threadId = ThreadId.make("runtime-thread-delete-concurrent");
      const updateCommandId = CommandId.make("runtime-thread-delete-concurrent-update");
      yield* projects.create({
        commandId: CommandId.make("runtime-project-delete-concurrent-create"),
        projectId,
        title: "Concurrent deletion",
        workspaceRoot: "/work/concurrent-deletion",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-thread-delete-concurrent-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const updateReady = yield* Deferred.make<void>();
      const releaseUpdate = yield* Deferred.make<void>();
      const deletionQueued = yield* Deferred.make<void>();
      const commitCommand = eventSink.commitCommand;
      const withLock = executor.withLock;
      let threadLockRequests = 0;
      const commitSpy = vi
        .spyOn(eventSink, "commitCommand")
        .mockImplementation((input) =>
          input.commandId === updateCommandId
            ? Deferred.succeed(updateReady, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUpdate)),
                Effect.andThen(commitCommand(input)),
              )
            : commitCommand(input),
        );
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== threadId || ++threadLockRequests !== 2) return withLock(key, effect);
        return Deferred.succeed(deletionQueued, undefined).pipe(
          Effect.andThen(withLock(key, effect)),
        );
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const updateFiber = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: updateCommandId,
            threadId,
            title: "Updated before deletion",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(updateReady),
          Fiber.join(updateFiber).pipe(
            Effect.andThen(Effect.die("The update completed before reaching its commit barrier.")),
          ),
        );
        const deleteFiber = yield* projects
          .delete({
            commandId: CommandId.make("runtime-project-delete-concurrent-delete"),
            projectId,
            force: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(deletionQueued),
          Fiber.join(deleteFiber).pipe(
            Effect.andThen(Effect.die("Project deletion bypassed the in-flight thread command.")),
          ),
        );
        yield* Deferred.succeed(releaseUpdate, undefined);
        yield* Fiber.join(updateFiber);
        const deletedProject = yield* Fiber.join(deleteFiber);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.isNotNull(deletedProject.deletedAt);
        assert.isNotNull(projection.thread.deletedAt);
        assert.equal(projection.thread.title, "Updated before deletion");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            commitSpy.mockRestore();
            lockSpy.mockRestore();
          }),
        ),
      );
    }),
  );

  it.effect(
    "deletes a side chat with its parent only after the side chat's in-flight command",
    () =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const projectId = ProjectId.make("runtime-side-chat-delete");
        const parentId = ThreadId.make("runtime-side-chat-delete-parent");
        const sideChatId = ThreadId.make("runtime-side-chat-delete-child");
        const updateCommandId = CommandId.make("runtime-side-chat-delete-update");
        yield* projects.create({
          commandId: CommandId.make("runtime-side-chat-delete-project"),
          projectId,
          title: "Side chat deletion",
          workspaceRoot: "/work/side-chat-deletion",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("runtime-side-chat-delete-create"),
          createdBy: "user",
          creationSource: "web",
          threadId: parentId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("runtime-side-chat-delete-fork"),
          sourceThreadId: parentId,
          targetThreadId: sideChatId,
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });

        const updateReady = yield* Deferred.make<void>();
        const releaseUpdate = yield* Deferred.make<void>();
        const deletionQueued = yield* Deferred.make<void>();
        const commitCommand = eventSink.commitCommand;
        const withLock = executor.withLock;
        let sideChatLockRequests = 0;
        const commitSpy = vi
          .spyOn(eventSink, "commitCommand")
          .mockImplementation((input) =>
            input.commandId === updateCommandId
              ? Deferred.succeed(updateReady, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseUpdate)),
                  Effect.andThen(commitCommand(input)),
                )
              : commitCommand(input),
          );
        const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
          key,
          effect,
        ) => {
          if (key !== sideChatId || ++sideChatLockRequests !== 2) return withLock(key, effect);
          return Deferred.succeed(deletionQueued, undefined).pipe(
            Effect.andThen(withLock(key, effect)),
          );
        };
        const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
        yield* Effect.gen(function* () {
          const updateFiber = yield* orchestrator
            .dispatch({
              type: "thread.metadata.update",
              commandId: updateCommandId,
              threadId: sideChatId,
              title: "Updated before deletion",
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(updateReady),
            Fiber.join(updateFiber).pipe(
              Effect.andThen(
                Effect.die("The update completed before reaching its commit barrier."),
              ),
            ),
          );
          const deleteFiber = yield* orchestrator
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make("runtime-side-chat-delete-parent"),
              threadId: parentId,
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(deletionQueued),
            Fiber.join(deleteFiber).pipe(
              Effect.andThen(Effect.die("Parent deletion bypassed the side chat's command.")),
            ),
          );
          yield* Deferred.succeed(releaseUpdate, undefined);
          yield* Fiber.join(updateFiber);
          yield* Fiber.join(deleteFiber);
          const sideChat = yield* orchestrator.getThreadProjection(sideChatId);
          assert.isNotNull(sideChat.thread.deletedAt);
          assert.equal(sideChat.thread.title, "Updated before deletion");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              commitSpy.mockRestore();
              lockSpy.mockRestore();
            }),
          ),
        );
      }),
  );

  // A fork from a side chat onto its parent used to lock the side chat, then the parent: the
  // reverse of the parent delete's order.
  it.effect("a parent delete and a fork from its side chat onto the parent do not deadlock", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-side-chat-lock-order");
      const parentId = ThreadId.make("runtime-side-chat-lock-order-parent");
      const sideChatId = ThreadId.make("runtime-side-chat-lock-order-child");
      yield* projects.create({
        commandId: CommandId.make("runtime-side-chat-lock-order-project"),
        projectId,
        title: "Side chat lock order",
        workspaceRoot: "/work/side-chat-lock-order",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-side-chat-lock-order-create"),
        createdBy: "user",
        creationSource: "web",
        threadId: parentId,
        projectId,
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("runtime-side-chat-lock-order-fork"),
        sourceThreadId: parentId,
        targetThreadId: sideChatId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });

      const deleteHoldsParent = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<void>();
      const forkWaitsForParent = yield* Deferred.make<void>();
      const withLock = executor.withLock;
      let parentLockRequests = 0;
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== parentId) return withLock(key, effect);
        // Dispatch builds locks it may not run, so count when one runs.
        return Effect.suspend(() =>
          ++parentLockRequests === 1
            ? withLock(
                key,
                Deferred.succeed(deleteHoldsParent, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseDelete)),
                  Effect.andThen(effect),
                ),
              )
            : Deferred.succeed(forkWaitsForParent, undefined).pipe(
                Effect.andThen(withLock(key, effect)),
              ),
        );
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const deleteFiber = yield* orchestrator
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make("runtime-side-chat-lock-order-delete"),
            threadId: parentId,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(deleteHoldsParent);
        const forkFiber = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("runtime-side-chat-lock-order-fork-back"),
            sourceThreadId: sideChatId,
            targetThreadId: parentId,
            sourcePoint: { type: "latest_stable" },
            sideChat: true,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(forkWaitsForParent);
        yield* Deferred.succeed(releaseDelete, undefined);
        yield* Fiber.join(deleteFiber);
        yield* Fiber.join(forkFiber);
        assert.isNotNull((yield* orchestrator.getThreadProjection(parentId)).thread.deletedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);
      }).pipe(Effect.ensuring(Effect.sync(() => lockSpy.mockRestore())));
    }),
  );
});

const layerSharedApplicationDataPlaneTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerEventInfrastructure,
).pipe(
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      readRepositoryIdentity: () => Effect.succeed(null),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerTest)("OrchestrationV2LayerLive", (it) => {
  const seedFailingRollbackThread = (name: string) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make(name);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}-create`),
        threadId,
        projectId: ProjectId.make(`${name}-project`),
        title: "Rollback failure",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: `/tmp/t3-${name}`,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}-message`),
        threadId,
        messageId: MessageId.make(`${name}-message`),
        text: "Create the provider thread and checkpoint scope.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const scope = (yield* orchestrator.getThreadProjection(threadId)).checkpointScopes[0]!;
      const now = yield* DateTime.now;
      const checkpointId = CheckpointId.make(`${name}-checkpoint`);
      yield* eventSink.write({
        commandId: CommandId.make(`${name}-seed`),
        events: [
          {
            id: EventId.make(`${name}-checkpoint-event`),
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
              ref: CheckpointRef.make(`refs/t3/${name}`),
              status: "ready",
              files: [],
              capturedAt: now,
            },
          },
        ],
      });
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "not under test",
      });
      return {
        threadId,
        rollback: (commandId: CommandId) =>
          orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId,
            threadId,
            checkpointId,
            scopeId: scope.id,
            restoreFiles: false,
          }),
      };
    });

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
          const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer));
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

  const seedPendingQuestion = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: RunId | null,
    responseCapability: OrchestrationV2RuntimeRequest["responseCapability"],
  ) {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make(`${threadId}:request`);
    const nodeId = NodeId.make(`${threadId}:node`);
    const itemId = TurnItemId.make(`${threadId}:item`);
    yield* eventSink.write({
      commandId: CommandId.make(`${threadId}:seed`),
      events: [
        {
          id: EventId.make(`${threadId}:node-event`),
          type: "node.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`${threadId}:request-event`),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability,
            createdAt: now,
            resolvedAt: null,
          },
        },
        {
          id: EventId.make(`${threadId}:item-event`),
          type: "turn-item.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: itemId,
            type: "user_input_request",
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            requestId,
            questions: [
              { id: "color", header: "Color", question: "Which color?", options: [] },
              {
                id: "sizes",
                header: "Sizes",
                question: "Which sizes?",
                options: [],
                multiSelect: true,
              },
              {
                id: "note",
                header: "Note",
                question: "Anything else?",
                options: [],
                required: false,
              },
            ],
          },
        },
      ],
    });
    return { requestId, nodeId, itemId };
  });

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

  it.effect("reports an answer that never reaches its provider without reopening it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("runtime-lost-answer");
      // Projected as attached, but no live session holds it, so every delivery fails.
      const providerSessionId = ProviderSessionId.make("runtime-lost-answer-session");
      const requestId = RuntimeRequestId.make("runtime-lost-answer-request");
      const nodeId = NodeId.make("runtime-lost-answer-node");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-lost-answer-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("runtime-lost-answer-project"),
        title: "Lost answer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* eventSink.write({
        commandId: CommandId.make("runtime-lost-answer-seed"),
        events: [
          {
            id: EventId.make("runtime-lost-answer-session-event"),
            type: "provider-session.attached",
            threadId,
            driver,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              status: "running",
              cwd: process.cwd(),
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make("runtime-lost-answer-node-event"),
            type: "node.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "user_input_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make("runtime-lost-answer-request-event"),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "live", providerSessionId },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      const commandId = CommandId.make("runtime-lost-answer-answer");
      const answers = { color: "Blue" };
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId,
        answers,
      });
      const errors = orchestrator
        .getThreadProjection(threadId)
        .pipe(
          Effect.map((projection) => projection.turnItems.filter((item) => item.type === "error")),
        );

      // A delivery that can still be retried reports nothing.
      yield* worker.drain();
      assert.deepEqual(yield* errors, []);
      for (let attempt = 1; attempt < 5; attempt++) {
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain();
      }

      const [deliveryEffect] = yield* outbox.listByCommandId(commandId);
      assert.equal(deliveryEffect?.request.type, "runtime-request.respond");
      assert.equal(deliveryEffect?.status, "failed");
      const failed = yield* orchestrator.getThreadProjection(threadId);
      const reported = failed.turnItems.filter((item) => item.type === "error");
      assert.equal(reported.length, 1);
      assert.equal(reported[0]?.status, "failed");
      assert.equal(reported[0]?.nodeId, nodeId);
      // The answer stays recorded; the user is not asked again.
      const request = failed.runtimeRequests.find((row) => row.id === requestId);
      assert.equal(request?.status, "resolved");
      assert.deepEqual(request?.answers, answers);
    }),
  );

  it.effect("dismisses message-capable questions directly and while settling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;

      const seedQuestion = Effect.fn("runtimeLayerTest.seedQuestion")(function* (name: string) {
        const threadId = ThreadId.make(`${name}-thread`);
        const requestId = RuntimeRequestId.make(`${name}-request`);
        const nodeId = NodeId.make(`${name}-node`);
        const itemId = TurnItemId.make(`${name}-item`);
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}-create`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make(`${name}-project`),
          title: "Dismissible question",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* eventSink.write({
          commandId: CommandId.make(`${name}-seed`),
          events: [
            {
              id: EventId.make(`${name}-node-event`),
              type: "node.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: nodeId,
                kind: "user_input_request",
                status: "waiting",
                countsForRun: false,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: requestId,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make(`${name}-request-event`),
              type: "runtime-request.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              id: EventId.make(`${name}-item-event`),
              type: "turn-item.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: itemId,
                type: "user_input_request",
                threadId,
                runId: null,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                requestId,
                responseMode: "message",
                questions: [{ id: "choice", header: "Choice", question: "Continue?", options: [] }],
              },
            },
          ],
        });
        return { threadId, requestId, nodeId, itemId };
      });

      const dismissed = yield* seedQuestion("runtime-dismiss-question");
      yield* orchestrator.dispatch({
        type: "thread.user-input.dismiss",
        commandId: CommandId.make("runtime-dismiss-question-command"),
        threadId: dismissed.threadId,
        requestId: dismissed.requestId,
      });
      const dismissedProjection = yield* orchestrator.getThreadProjection(dismissed.threadId);
      assert.equal(dismissedProjection.runtimeRequests[0]?.status, "resolved");
      assert.equal(dismissedProjection.runtimeRequests[0]?.decision, "cancel");
      assert.equal(
        dismissedProjection.nodes.find((node) => node.id === dismissed.nodeId)?.status,
        "cancelled",
      );
      assert.equal(
        dismissedProjection.turnItems.find((item) => item.id === dismissed.itemId)?.status,
        "cancelled",
      );
      assert.lengthOf(dismissedProjection.messages, 0);

      const settled = yield* seedQuestion("runtime-settle-question");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-settle-question-command"),
        threadId: settled.threadId,
      });
      const settledProjection = yield* orchestrator.getThreadProjection(settled.threadId);
      assert.equal(settledProjection.thread.settledOverride, "settled");
      assert.equal(settledProjection.runtimeRequests[0]?.status, "resolved");
      assert.equal(settledProjection.runtimeRequests[0]?.decision, "cancel");
      assert.equal(
        settledProjection.nodes.find((node) => node.id === settled.nodeId)?.status,
        "cancelled",
      );
      assert.equal(
        settledProjection.turnItems.find((item) => item.id === settled.itemId)?.status,
        "cancelled",
      );
    }),
  );

  it.effect("refuses busy merge-back targets without blocking the queue", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("runtime-layer-waiting-merge-project");
      const targetThreadId = ThreadId.make("runtime-layer-waiting-merge-target");
      const sourceThreadId = ThreadId.make("runtime-layer-waiting-merge-source");
      const baseRunId = RunId.make("runtime-layer-waiting-merge-base-run");
      const sourceRunId = RunId.make("runtime-layer-waiting-merge-source-run");
      const sourceProviderThreadId = ProviderThreadId.make(
        "runtime-layer-waiting-merge-provider-thread",
      );
      const forkTransferId = ContextTransferId.make("runtime-layer-waiting-merge-fork-transfer");

      yield* seedProject({
        projectId,
        title: "Merge-back project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(now),
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-waiting-merge-create-target"),
        threadId: targetThreadId,
        projectId,
        title: "Waiting merge target",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);

      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-waiting-merge-seed"),
        events: [
          {
            id: EventId.make("runtime-layer-waiting-merge-source-thread-event"),
            type: "thread.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...target.thread,
              id: sourceThreadId,
              title: "Waiting merge source",
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: targetThreadId,
                relationshipToParent: "fork",
                rootThreadId: targetThreadId,
              },
              forkedFrom: {
                type: "run",
                threadId: targetThreadId,
                runId: baseRunId,
              },
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-fork-transfer-event"),
            type: "context-transfer.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: forkTransferId,
              type: "fork",
              sourceThreadId: targetThreadId,
              targetThreadId: sourceThreadId,
              sourcePoint: { threadId: targetThreadId, runId: baseRunId },
              basePoint: null,
              sourceProviderInstanceId: modelSelection.instanceId,
              targetProviderInstanceId: modelSelection.instanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-provider-thread-event"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceProviderThreadId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: "native-waiting-merge-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-source-run-event"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: sourceProviderThreadId,
              userMessageId: MessageId.make("runtime-layer-waiting-merge-message"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "waiting",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-merge-target-start"),
        threadId: targetThreadId,
        messageId: MessageId.make("runtime-layer-merge-target-message"),
        text: "Keep working in the parent.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const activeTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const targetRun = activeTarget.runs[0]!;
      for (const status of ["preparing", "starting", "waiting", "queued", "running"] as const) {
        yield* eventSink.write({
          commandId: CommandId.make(`runtime-layer-merge-target-${status}`),
          events: [
            {
              id: EventId.make(`runtime-layer-merge-target-${status}-event`),
              type: "run.updated",
              threadId: targetThreadId,
              runId: targetRun.id,
              occurredAt: now,
              payload: { ...targetRun, status },
            },
          ],
        });
        const error = yield* orchestrator
          .dispatch({
            type: "thread.merge_back",
            createdBy: "user",
            creationSource: "mobile",
            commandId: CommandId.make(`runtime-layer-merge-refused-${status}`),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "run", runId: sourceRunId },
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
        assert.equal(
          error.cause,
          "Finish or stop the target thread's active work and clear its queue before merging back.",
        );
        const refusedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.deepEqual(refusedTarget.contextTransfers, activeTarget.contextTransfers);
        assert.equal(refusedTarget.runs[0]?.status, status);
      }
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-merge-target-queue"),
        threadId: targetThreadId,
        messageId: MessageId.make("runtime-layer-merge-target-queued-message"),
        text: "Run this after the current turn.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
      });
      const queuedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const queuedRun = queuedTarget.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("runtime-layer-merge-target-cancel-queue"),
        threadId: targetThreadId,
        runId: queuedRun.id,
      });
      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-merge-target-complete"),
        events: [
          {
            id: EventId.make("runtime-layer-merge-target-completed-event"),
            type: "run.updated",
            threadId: targetThreadId,
            runId: targetRun.id,
            occurredAt: now,
            payload: { ...targetRun, status: "completed", completedAt: now },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "thread.merge_back",
        createdBy: "user",
        creationSource: "mobile",
        commandId: CommandId.make("runtime-layer-waiting-merge"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdAt: now,
      });

      const mergedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const transfer = mergedTarget.contextTransfers.find(
        (candidate) => candidate.type === "merge_back",
      );
      assert.isDefined(transfer);
      assert.equal(transfer.status, "pending");
      assert.equal(transfer.sourceThreadId, sourceThreadId);
      assert.equal(transfer.targetThreadId, targetThreadId);
      assert.equal(transfer.sourcePoint.runId, sourceRunId);
      assert.isUndefined(transfer.sourcePoint.checkpointId);
      assert.equal(transfer.sourcePoint.providerThreadRef?.nativeId, "native-waiting-merge-source");
      assert.equal(transfer.basePoint?.runId, baseRunId);
      assert.isNull(transfer.error);
    }),
  );
});

it.layer(layerLegacyImportTest)("OrchestrationV2 legacy import", (it) => {
  it.effect("hydrates imported transcripts before commands and propagates hydration failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const metadataThreadId = ThreadId.make("runtime-layer-legacy-metadata-thread");
      const failureThreadId = ThreadId.make("runtime-layer-legacy-failure-thread");
      const projectId = ProjectId.make("runtime-layer-legacy-project");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Legacy project',
          '/tmp/runtime-layer-legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        ) VALUES
          (
            ${metadataThreadId},
            ${projectId},
            'Legacy metadata title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          ),
          (
            ${failureThreadId},
            ${projectId},
            'Legacy failure title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:runtime-layer-legacy:1',
            ${metadataThreadId},
            NULL,
            'user',
            'First imported question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:2',
            ${metadataThreadId},
            NULL,
            'assistant',
            'First imported answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:3',
            ${metadataThreadId},
            NULL,
            'user',
            'Latest imported question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:failure',
            ${failureThreadId},
            NULL,
            'user',
            'Imported context must load before archive',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          )
      `;

      yield* importer.reconcileShells;
      assert.isTrue((yield* maintenance.verify).valid);

      yield* threadManagement.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-legacy-metadata-update"),
        threadId: metadataThreadId,
        title: "Updated after import",
      });
      const updatedProjection = yield* threadManagement.getThreadProjection(metadataThreadId);
      assert.equal(updatedProjection.thread.title, "Updated after import");
      assert.deepEqual(
        updatedProjection.messages.map((message) => message.text),
        ["First imported question", "First imported answer", "Latest imported question"],
      );

      yield* sql`
        ALTER TABLE projection_thread_messages
        RENAME TO projection_thread_messages_unavailable
      `;
      const { projectionFailure, hydrationFailure } = yield* Effect.all({
        projectionFailure: threadManagement.getThreadProjection(failureThreadId).pipe(Effect.flip),
        hydrationFailure: threadManagement
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("runtime-layer-legacy-failed-archive"),
            threadId: failureThreadId,
          })
          .pipe(Effect.flip),
      }).pipe(
        Effect.ensuring(
          sql`
            ALTER TABLE projection_thread_messages_unavailable
            RENAME TO projection_thread_messages
          `.pipe(Effect.orDie),
        ),
      );
      assert.instanceOf(projectionFailure, Orchestrator.OrchestratorProjectionError);
      assert.instanceOf(projectionFailure.cause, LegacyV1ThreadImporter.LegacyV1ThreadImportError);
      assert.instanceOf(hydrationFailure, Orchestrator.OrchestratorDispatchError);
      assert.instanceOf(hydrationFailure.cause, LegacyV1ThreadImporter.LegacyV1ThreadImportError);

      const projectionAfterFailure = yield* orchestrator.getThreadProjection(failureThreadId);
      assert.isNull(projectionAfterFailure.thread.archivedAt);

      yield* threadManagement.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-legacy-retried-archive"),
        threadId: failureThreadId,
      });
      const projectionAfterRetry = yield* threadManagement.getThreadProjection(failureThreadId);
      assert.isNotNull(projectionAfterRetry.thread.archivedAt);
    }),
  );
});

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
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
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
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
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
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
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

  it.effect.each(["manual", "automatic"])("settling ends every pull request watch: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadId = ThreadId.make(`pr-watch-settle-${mode}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-settle-create-${mode}`),
        threadId,
        projectId: ProjectId.make("pr-watch-settle-project"),
        title: "Settle watched PRs",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      for (const number of [7, 8]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-settle-start-${mode}-${number}`),
          threadId,
          ...key,
          number,
          watching: true,
          link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
        });
      }
      const before = yield* orchestrator.getThreadShell(threadId);
      const started = before?.pullRequests?.[0]?.watch;
      assert.isDefined(started);
      if (started === undefined || before === null) return;
      yield* orchestrator.dispatch({
        ...(mode === "manual"
          ? { type: "thread.settle" as const }
          : { type: "thread.auto-settle" as const, snapshotAt: before.updatedAt }),
        commandId: CommandId.make(`pr-watch-settle-${mode}`),
        threadId,
      });
      const expected = before.pullRequests?.map(({ watch, ...link }) => ({
        ...link,
        endedWatch: watch,
      }));
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);

      for (const wake of [
        undefined,
        {
          messageId: MessageId.make(`pr-watch-settle-late-wake-${mode}`),
          text: "Update",
          notification: {
            source: { kind: "monitor" as const },
            outcome: "updated" as const,
            summary: "#7",
          },
        },
      ]) {
        const late = yield* orchestrator
          .dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`pr-watch-settle-late-${mode}-${wake !== undefined}`),
            threadId,
            ...key,
            number: 7,
            startedAt: started.startedAt,
            watch: { ...started, headSha: "late", wakes: 1 },
            ...(wake === undefined ? {} : { wake }),
          })
          .pipe(Effect.flip);
        assert.equal(late._tag, "OrchestratorDispatchError");
      }
      const restart = {
        type: "thread.pull-request.watch" as const,
        threadId,
        ...key,
        number: 7,
        watching: true,
      };
      const blocked = yield* orchestrator
        .dispatch({
          ...restart,
          commandId: CommandId.make(`pr-watch-settle-blocked-${mode}`),
        })
        .pipe(Effect.flip);
      assert.equal(blocked._tag, "OrchestratorDispatchError");
      assert.deepEqual((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, []);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`pr-watch-settle-unsettle-${mode}`),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        ...restart,
        commandId: CommandId.make(`pr-watch-settle-restart-${mode}`),
      });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);
    }),
  );

  it.effect("archiving ends watches, and an archived thread cannot start one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-archive");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-archive-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-archive-project"),
        title: "Archive watched PR",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = {
        type: "thread.pull-request.watch" as const,
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" as const },
      };
      const watched = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch !== undefined,
      );
      yield* orchestrator.dispatch({
        ...watch,
        commandId: CommandId.make("pr-watch-archive-start"),
      });
      assert.isTrue(yield* watched);

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("pr-watch-archive"),
        threadId,
      });
      assert.isFalse(yield* watched);
      const refused = yield* orchestrator
        .dispatch({ ...watch, commandId: CommandId.make("pr-watch-archive-restart") })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("pr-watch-unarchive"),
        threadId,
      });
      assert.isFalse(yield* watched);
    }),
  );

  it.effect("ends a watch it cannot read, and tells the agent", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-unreadable");
      const projectId = ProjectId.make("pr-watch-unreadable-project");
      yield* seedProject({
        projectId,
        title: "Watch unreadable",
        workspaceRoot: "/workspace/watch-unreadable",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-unreadable-create"),
        threadId,
        projectId,
        title: "Watch unreadable",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-unreadable-start"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 8,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/8", source: "agent" },
      });
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () => Effect.die("host unreachable"),
              activity: () => Effect.die("host unreachable"),
            }),
          ),
        ),
      );
      for (let pass = 0; pass < 15; pass += 1) yield* reactor.sweep;

      const thread = yield* orchestrator.getThreadShell(threadId);
      assert.isUndefined(thread?.pullRequests?.[0]?.watch);
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(
        messages.flatMap((message) => message.notification?.summary ?? []),
        ["#8: stopped watching, could not read it"],
      );
    }),
  );

  it.effect("wakes once for a state it reported, across a restart and a new watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-told");
      const projectId = ProjectId.make("pr-watch-told-project");
      yield* seedProject({
        projectId,
        title: "Watch told",
        workspaceRoot: "/workspace/watch-told",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-told-create"),
        threadId,
        projectId,
        title: "Watch told",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-told-${id}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 12,
          watching: on,
          link: { url: "https://github.com/pingdotgg/t3code/pull/12", source: "agent" },
        });
      yield* watch(true, "start");

      let headSha = "ad70160aaa";
      const host = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 12,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks: ["lint", "test"].map((name) => ({
                name,
                status: "success" as const,
                description: null,
                url: null,
                required: true,
              })),
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      const restarted = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* restarted.sweep;
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      yield* watch(false, "stop");
      yield* watch(true, "again");
      yield* restarted.sweep;
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      headSha = "bbbbbbbbbb";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      assert.deepEqual(yield* summaries, ["#12: checks passed", "#12: checks passed"]);
      yield* watch(false, "end");
    }),
  );

  it.effect("finishes owed checks once after pending sweeps, a restart, and a re-watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-owed");
      const projectId = ProjectId.make("pr-watch-owed-project");
      yield* seedProject({
        projectId,
        title: "Watch owed",
        workspaceRoot: "/workspace/watch-owed",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-owed-create"),
        threadId,
        projectId,
        title: "Watch owed",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-owed-${id}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 12,
          watching: on,
          link: { url: "https://github.com/pingdotgg/t3code/pull/12", source: "agent" },
        });
      yield* watch(true, "start");

      let remainingStatus: "pending" | "success" = "pending";
      const host = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 12,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha: "ad70160aaa",
              checks: ["lint", "test"].map((name) => ({
                name,
                status: name === "test" ? remainingStatus : ("success" as const),
                description: null,
                url: null,
                required: name === "lint",
              })),
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* worker.drain();
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.owedChecks,
        ["test"],
      );
      // The fresh reactor reloads the nonempty obligation from the persisted watch.
      const restarted = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      // A new watch on the same pull request knows what the last one told.
      yield* watch(false, "stop");
      yield* watch(true, "again");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.owedChecks,
        ["test"],
      );
      remainingStatus = "success";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed", "#12: checks passed"]);
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed", "#12: checks passed"]);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.owedChecks,
        [],
      );
      yield* watch(false, "end");
    }),
  );

  // regression: #21155 watching a pull request again repeated news the thread already got
  it.effect("a watch that ends on the comment limit keeps what its last pass saw", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-limit");
      const projectId = ProjectId.make("pr-watch-limit-project");
      yield* seedProject({
        projectId,
        title: "Watch limit",
        workspaceRoot: "/workspace/watch-limit",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-limit-create"),
        threadId,
        projectId,
        title: "Watch limit",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 13 };
      const watch = (id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-limit-${id}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/13", source: "agent" },
        });
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0],
      );
      yield* watch("start");
      const started = (yield* watchOf)?.watch;
      assert.isDefined(started);
      if (started === undefined) return;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-limit-told"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: {
          ...started,
          headSha: "abc1234def",
          passed: true,
          passedChecks: ["lint"],
          wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1,
        },
      });

      let status: "pending" | "success" = "pending";
      const commentAt = DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(started.startedAt), { seconds: 1 }),
      );
      const host = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({ projectId, number: 13, at: commentAt }),
              checks: [{ name: "lint", status, description: null, url: null, required: true }],
            })),
          activity: () =>
            Effect.succeed({
              comments: [
                {
                  id: "reviewer-comment",
                  kind: "issue-comment" as const,
                  author: { login: "reviewer", name: null, avatarUrl: null },
                  body: "One more thing.",
                  createdAt: commentAt,
                  url: "https://github.com/pingdotgg/t3code/pull/13#comment",
                  path: null,
                  reviewState: null,
                },
              ],
              commentCount: 1,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      const ended = yield* watchOf;
      assert.isUndefined(ended?.watch);
      assert.isFalse(ended?.endedWatch?.passed);
      assert.deepEqual(yield* summaries, ["#13: new comments, stopped watching"]);

      status = "success";
      yield* TestClock.adjust("10 minutes");
      yield* watch("again");
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, [
        "#13: new comments, stopped watching",
        "#13: checks passed",
      ]);
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-limit-end"),
        threadId,
        ...key,
        watching: false,
      });
    }),
  );

  // regression: #23701 a head no check runs on never woke the watch
  it.effect("wakes once when no checks report on the head, without saying they passed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-no-checks");
      const projectId = ProjectId.make("pr-watch-no-checks-project");
      yield* seedProject({
        projectId,
        title: "Watch no checks",
        workspaceRoot: "/workspace/watch-no-checks",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-no-checks-create"),
        threadId,
        projectId,
        title: "Watch no checks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-no-checks-start"),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
      });

      // A docs-only push that path filters keep every workflow off.
      let headSha = "6074dd48ff";
      let checks: PullRequestDetail["checks"] = [];
      const host = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 14,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks,
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const wakes = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) =>
          messages.filter(
            (message) => message.notification !== undefined && message.notification !== null,
          ),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      const anHourOfSweeps = Effect.gen(function* () {
        for (let pass = 0; pass < 6; pass++) {
          yield* reactor.sweep;
          yield* TestClock.adjust("10 minutes");
        }
        yield* reactor.sweep;
      });

      yield* anHourOfSweeps;
      const told = yield* wakes;
      assert.equal(told.length, 1, "one wake for a head with no checks");
      assert.notMatch(told[0]!.text, /\bpass/i);
      assert.notEqual(told[0]!.notification?.outcome, "completed");

      // An empty read on a head whose checks were seen is a failed read, not "no checks".
      headSha = "7777777777";
      checks = [{ name: "lint", status: "pending", description: null, url: null, required: true }];
      // Without a fingerprint, a quiet pull request is read again only once the reread is due.
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      checks = [];
      yield* anHourOfSweeps;
      assert.equal((yield* wakes).length, 1);

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-no-checks-end"),
        threadId,
        ...key,
        watching: false,
      });
    }),
  );

  it.effect("wakes for checks that complete after the no-checks notice on the same head", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-late-checks");
      const projectId = ProjectId.make("pr-watch-late-checks-project");
      yield* seedProject({
        projectId,
        title: "Watch late checks",
        workspaceRoot: "/workspace/watch-late-checks",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-late-checks-create"),
        threadId,
        projectId,
        title: "Watch late checks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-late-checks-start"),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
      });

      const headSha = "6074dd48ff";
      let checks: PullRequestDetail["checks"] = [];
      const host = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 14,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks,
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const wakes = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) =>
          messages.filter(
            (message) => message.notification !== undefined && message.notification !== null,
          ),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));
      yield* sweep;
      assert.lengthOf(yield* wakes, 0);
      yield* TestClock.adjust("20 minutes");
      yield* sweep;
      const noChecks = yield* wakes;
      assert.lengthOf(noChecks, 1);
      assert.include(noChecks[0]!.text, "No checks have reported");
      assert.equal(noChecks[0]!.notification?.outcome, "updated");

      checks = [{ name: "lint", status: "pending", description: null, url: null, required: true }];
      yield* TestClock.adjust("10 minutes");
      yield* sweep;
      assert.lengthOf(yield* wakes, 1);

      checks = [{ name: "lint", status: "success", description: null, url: null, required: true }];
      yield* TestClock.adjust("10 minutes");
      yield* sweep;
      const completed = yield* wakes;
      assert.lengthOf(completed, 2);
      assert.equal(completed[1]!.notification?.summary, "#14: checks passed");
      assert.include(completed[1]!.text, "All 1 required check passed on 6074dd4.");
      assert.equal(completed[1]!.notification?.outcome, "completed");

      yield* TestClock.adjust("1 hour");
      yield* sweep;
      const settled = yield* wakes;
      assert.lengthOf(settled, 2);
      assert.lengthOf(
        settled.filter((message) => message.text.includes("No checks have reported")),
        1,
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-late-checks-end"),
        threadId,
        ...key,
        watching: false,
      });
      yield* worker.drain();
    }),
  );

  it.effect.each([true, false])(
    "reads a quiet head when its no-checks notice comes due (fingerprint: %s)",
    (fingerprinted) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-due-${fingerprinted}`);
        const projectId = ProjectId.make(`pr-watch-due-project-${fingerprinted}`);
        yield* seedProject({
          projectId,
          title: "Watch no-checks deadline",
          workspaceRoot: "/workspace/watch-due",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-due-create-${fingerprinted}`),
          threadId,
          projectId,
          title: "Watch no-checks deadline",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-due-start-${fingerprinted}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
        });

        let reads = 0;
        const host = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            // The host reports the same fingerprint throughout, so only the deadline can prompt a read.
            watchFingerprint: () =>
              Effect.succeed(fingerprinted ? { status: "quiet", remarks: "none" } : null),
            invalidate: () => Effect.void,
            detail: () =>
              Effect.sync(() => {
                reads++;
                return {
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 14,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "6074dd48ff",
                  checks: [],
                };
              }),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );
        const wakes = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) =>
            messages.filter((message) => message.text.includes("No checks have reported")),
        );
        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));

        yield* sweep;
        yield* TestClock.adjust("10 minutes");
        yield* sweep;
        assert.lengthOf(yield* wakes, 0);

        yield* TestClock.adjust("6 minutes");
        yield* sweep;
        const told = yield* wakes;
        assert.lengthOf(told, 1);
        assert.include(told[0]!.text, "after 16 minutes");

        // The notice clears the deadline, so the watch returns to its quiet cadence.
        const readsAfterNotice = reads;
        yield* TestClock.adjust("2 minutes");
        yield* sweep;
        assert.equal(reads, readsAfterNotice);
        assert.lengthOf(yield* wakes, 1);

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-due-end-${fingerprinted}`),
          threadId,
          ...key,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  // regression: #21155 watching a pull request again repeated news the thread already got
  it.effect("watching a dismissed stack layer again keeps what its last watch told", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-dismissed");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-dismissed-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-dismissed-project"),
        title: "Watch dismissed",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
      const url = "https://github.com/pingdotgg/t3code/pull/14";
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("pr-watch-dismissed-link"),
        threadId,
        ...key,
        url,
        source: "stack",
      });
      const watching = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-dismissed-${id}`),
          threadId,
          ...key,
          watching: on,
          link: { url, source: "agent" },
        });
      yield* watching(true, "start");
      const started = yield* watchOf;
      assert.isDefined(started);
      if (started === undefined) return;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-dismissed-told"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: { ...started, headSha: "abc1234def", passed: true, passedChecks: ["lint"] },
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("pr-watch-dismissed-unlink"),
        threadId,
        ...key,
      });
      yield* watching(true, "again");
      const again = yield* watchOf;
      assert.equal(again?.headSha, "abc1234def");
      assert.isTrue(again?.passed);
      yield* watching(false, "end");
    }),
  );

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
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
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
  const queueTestThread = (threadId: ThreadId) =>
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
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
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

const SCRATCH_ROOT = "/tmp/runtime-layer-promotion-scratch";
const SCRATCH_PROJECT_ID = ProjectId.make("runtime-layer-promotion-scratch");
const layerScratchPromotionTest = ScratchThreadPromotion.layer.pipe(
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      scratchRoot: Effect.succeedSome(SCRATCH_ROOT),
      isScratchProject: (projectId) => Effect.succeed(projectId === SCRATCH_PROJECT_ID),
      namedProjectsRoot: "/projects",
    }),
  ),
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(layerProjectDeletionTest),
);

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

it.layer(layerSharedApplicationDataPlaneTest)("visited projection", (it) => {
  it.effect("carries the visited watermark through the V2 shell projection", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-visited-project");
      const threadId = ThreadId.make("runtime-layer-visited-thread");
      const visitedAt = "2026-07-24T01:00:00.000Z";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-visited-project-create"),
        projectId,
        title: "Visited shell projection",
        workspaceRoot: "/tmp/runtime-layer-visited-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-visited-thread-create"),
        threadId,
        projectId,
        title: "Visited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const created = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(created.thread.lastVisitedAt);
      const createdUpdatedAt = created.thread.updatedAt;

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit"),
        threadId,
        visitedAt,
      });
      const visited = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(visited.thread.lastVisitedAt);
      assert.equal(DateTime.formatIso(visited.thread.lastVisitedAt!), visitedAt);
      assert.deepEqual(visited.thread.updatedAt, createdUpdatedAt);

      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit-stale"),
        threadId,
        visitedAt: "2026-07-24T00:30:00.000Z",
      });
      const afterStaleVisit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(DateTime.formatIso(afterStaleVisit.thread.lastVisitedAt!), visitedAt);

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread!.lastVisitedAt!), visitedAt);
      assert.deepEqual(thread!.updatedAt, createdUpdatedAt);

      const markUnread = yield* orchestrator
        .dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make("runtime-layer-visited-thread-mark-unread"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(markUnread, Orchestrator.OrchestratorDispatchError);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        'item:visited:unreadable-history', ${threadId}, 1, 'dynamic_tool', 'completed',
        ${visitedAt}, '{broken'
      )`;
      const nextVisitedAt = "2026-07-24T02:00:00.000Z";
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-without-history"),
        threadId,
        visitedAt: nextVisitedAt,
      });
      const [watermark] = yield* sql<{ readonly visited_at: string; readonly updated_at: string }>`
        SELECT json_extract(payload_json, '$.lastVisitedAt') AS visited_at, updated_at
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      assert.equal(watermark!.visited_at, nextVisitedAt);
      assert.equal(watermark!.updated_at, DateTime.formatIso(createdUpdatedAt));
      const invalidVisit = yield* orchestrator
        .dispatch({
          type: "thread.visit",
          commandId: CommandId.make("runtime-layer-visited-invalid-timestamp"),
          threadId,
          visitedAt: "invalid-timestamp",
        })
        .pipe(Effect.flip);
      assert.instanceOf(invalidVisit, Orchestrator.OrchestratorDispatchError);
    }),
  );

  it.effect("marks unread before the user's last turn when an automatic compaction followed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-mark-unread-compacted");
      const turnCompletedAt = DateTime.makeUnsafe("2026-07-24T10:00:00.000Z");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Compacted thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const runs = [
        { text: "Continue", at: turnCompletedAt },
        {
          text: "/compact",
          idleCompaction: "beforeCacheExpires" as const,
          at: DateTime.makeUnsafe("2026-07-24T11:00:00.000Z"),
        },
      ];
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make(`${threadId}:seed`),
        events: runs.flatMap(({ at, ...message }, index) => {
          const runId = RunId.make(`${threadId}:run-${index}`);
          const messageId = MessageId.make(`${threadId}:message-${index}`);
          return [
            {
              id: EventId.make(`${messageId}:event`),
              type: "message.updated" as const,
              threadId,
              occurredAt: at,
              payload: {
                ...message,
                id: messageId,
                threadId,
                runId,
                nodeId: null,
                role: "user" as const,
                attachments: [],
                streaming: false,
                createdBy: "user" as const,
                creationSource: "web" as const,
                createdAt: at,
                updatedAt: at,
              },
            },
            {
              id: EventId.make(`${runId}:event`),
              type: "run.created" as const,
              threadId,
              runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: at,
              payload: {
                id: runId,
                threadId,
                ordinal: index + 1,
                providerInstanceId: modelSelection.instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed" as const,
                queuePosition: null,
                requestedAt: at,
                startedAt: at,
                completedAt: at,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ];
        }),
      });

      yield* orchestrator.dispatch({
        type: "thread.mark-unread",
        commandId: CommandId.make(`${threadId}:mark-unread`),
        threadId,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.thread.lastVisitedAt,
        DateTime.subtract(turnCompletedAt, { milliseconds: 1 }),
      );
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(shell!.latestRunCompletedAt, turnCompletedAt);
      assert.deepEqual(shell!.lastVisitedAt, projection.thread.lastVisitedAt);

      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make(`${threadId}:visit`),
        threadId,
        visitedAt: DateTime.formatIso(turnCompletedAt),
      });
      const revisited = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(revisited!.lastVisitedAt, turnCompletedAt);
    }),
  );
});

it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("thread opens", (it) => {
  it.effect(
    "counts opens on the server clock, merges quick reopens, and keeps picked queries",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-layer-opened-thread");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("runtime-layer-opened-thread-create"),
          threadId,
          projectId: ProjectId.make("runtime-layer-opened-project"),
          title: "Opened thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        let visits = 0;
        const visit = (input: { readonly opened?: boolean; readonly searchQuery?: string }) =>
          orchestrator.dispatch({
            type: "thread.visit",
            commandId: CommandId.make(`runtime-layer-opened-visit-${++visits}`),
            threadId,
            // A client clock far in the past must not move the open time.
            visitedAt: "2000-01-01T00:00:00.000Z",
            ...input,
          });
        const opens = Effect.map(
          orchestrator.getShellSnapshot(),
          (shell) => shell.threads.find((thread) => thread.id === threadId)?.opens ?? null,
        );
        const start = DateTime.toEpochMillis(yield* DateTime.now);

        yield* visit({ opened: true, searchQuery: "  Upl " });
        assert.deepEqual(yield* opens, {
          openedAt: start,
          score: 1,
          picks: [{ query: "upl", at: start }],
        });

        yield* TestClock.adjust("1 minute");
        yield* visit({ opened: true, searchQuery: "Uploadthing docs" });
        assert.deepEqual(yield* opens, {
          openedAt: start,
          score: 1,
          picks: [
            { query: "uploadthing docs", at: start + 60_000 },
            { query: "upl", at: start },
          ],
        });

        yield* TestClock.adjust("14 days");
        yield* visit({});
        yield* visit({ opened: true });
        const later = yield* opens;
        assert.closeTo(later!.score, 1 + 2 ** (-(14 * 24 * 60 + 1) / (14 * 24 * 60)), 1e-9);
        assert.equal(later!.openedAt, DateTime.toEpochMillis(yield* DateTime.now));
        // Opening without a query keeps each pick and its time.
        assert.deepEqual(later!.picks, [
          { query: "uploadthing docs", at: start + 60_000 },
          { query: "upl", at: start },
        ]);
      }),
  );
});

it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("compact PR events", (it) => {
  it.effect("persists only the changed PR link and replays it without losing other links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("compact-pr-sync");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("compact-pr-create"),
        threadId,
        projectId: ProjectId.make("compact-pr-project"),
        title: "PR sync",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      const repositoryWebUrl = "https://github.com/pingdotgg/t3code/pull/2";
      for (const number of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`compact-pr-link-${number}`),
          threadId,
          ...key,
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: "manual",
          ...(number === 2 ? { repositoryWebUrl } : {}),
        });
      }
      const watchedLink = {
        url: "https://github.com/pingdotgg/t3code/pull/3",
        repositoryWebUrl: "https://github.com/pingdotgg/t3code/pull/3",
        source: "manual" as const,
      };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-new"),
        threadId,
        ...key,
        number: 3,
        watching: true,
        link: watchedLink,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-existing"),
        threadId,
        ...key,
        number: 2,
        watching: true,
      });
      const before = yield* orchestrator.getThreadShell(threadId);
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("compact-pr-sync"),
        threadId,
        ...key,
        number: 2,
        snapshot: {
          state: "open",
          title: "Updated PR",
          headBranch: "feature/pr",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-13T12:00:00.000Z",
        },
        stack: {
          kind: "native",
          id: "updated",
          number: 2,
          url: "https://github.com/pingdotgg/t3code/pull/2",
          base: "main",
          layers: [],
        },
      });
      const rows = yield* sql<{ event_type: string; payload_json: string }>`
        SELECT event_type, payload_json FROM orchestration_events
        WHERE command_id = ${"compact-pr-sync"}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_type, "thread.pull-request-link-updated");
      const payload = JSON.parse(rows[0]!.payload_json);
      assert.equal(payload.number, 2);
      assert.isUndefined(payload.pullRequests);
      const after = yield* orchestrator.getThreadShell(threadId);
      assert.equal(after?.pullRequests?.length, 3);
      assert.deepEqual(after?.pullRequests?.[0], before?.pullRequests?.[0]);
      assert.deepEqual(after?.pullRequests?.[2], before?.pullRequests?.[2]);
      assert.equal(after?.pullRequests?.[1]?.stack?.id, "updated");
      assert.propertyVal(after?.pullRequests?.[1], "repositoryWebUrl", repositoryWebUrl);
      assert.deepInclude(after?.pullRequests?.[2], watchedLink);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests,
        after?.pullRequests,
      );
      for (const [commandId, title] of [
        ["compact-pr-sync-again", "Still open PR"],
        ["compact-pr-sync-merged", "Merged PR"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(commandId),
          threadId,
          ...key,
          number: 2,
          snapshot: {
            state: title === "Merged PR" ? "merged" : "open",
            title,
            headBranch: "feature/pr",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-10-13T13:00:00.000Z",
          },
          stack: null,
        });
      }
      const latest = yield* orchestrator.getThreadShell(threadId);
      yield* maintenance.compactEventStore();
      const linkEvents = yield* sql<{ command_id: string }>`
        SELECT command_id FROM orchestration_events
        WHERE stream_id = ${threadId} AND event_type = 'thread.pull-request-link-updated'
        ORDER BY sequence
      `;
      assert.deepEqual(
        linkEvents.map((row) => row.command_id),
        ["compact-pr-sync", "compact-pr-sync-merged"],
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests,
        latest?.pullRequests,
      );

      // Visits preserve updatedAt, so compaction must retain earlier renames; later renames supersede visits.
      const threadEvents = () => sql<{ event_type: string }>`
        SELECT event_type FROM orchestration_events
        WHERE stream_id = ${threadId}
          AND event_type IN ('thread.metadata-updated', 'thread.visited')
        ORDER BY sequence
      `;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("compact-pr-rename"),
        threadId,
        title: "Renamed before visit",
      });
      for (const [commandId, visitedAt] of [
        ["compact-pr-visit", "2026-10-13T14:00:00.000Z"],
        ["compact-pr-visit-again", "2026-10-13T15:00:00.000Z"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.visit",
          commandId: CommandId.make(commandId),
          threadId,
          visitedAt,
        });
      }
      yield* maintenance.compactEventStore();
      assert.deepEqual(
        (yield* threadEvents()).map((row) => row.event_type),
        ["thread.metadata-updated", "thread.visited"],
      );
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("compact-pr-rename-again"),
        threadId,
        title: "Renamed after visit",
      });
      yield* maintenance.compactEventStore();
      assert.deepEqual(
        (yield* threadEvents()).map((row) => row.event_type),
        ["thread.metadata-updated"],
      );
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("shared application data plane", (it) => {
  it.effect("orders retained project transactions and V2 thread transactions in one source", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("runtime-layer-shared-project");
      const threadId = ThreadId.make("runtime-layer-shared-thread");
      const projectInput = {
        commandId: CommandId.make("runtime-layer-shared-project-create"),
        projectId,
        title: "Shared application source",
        workspaceRoot: "/tmp/runtime-layer-shared-project",
      };

      const created = yield* projects.create(projectInput);
      const retried = yield* projects.create(projectInput);
      assert.deepEqual(retried, created);

      const delivered = yield* Queue.unbounded<ApplicationStoredEvent>();
      yield* applicationEvents.streamApplicationEvents().pipe(
        Stream.take(2),
        Stream.runForEach((event) => Queue.offer(delivered, event)),
        Effect.forkScoped,
      );

      const projectEvent = yield* Queue.take(delivered);
      assert.isTrue("aggregateKind" in projectEvent && projectEvent.aggregateId === projectId);

      const threadResult = yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-shared-thread-create"),
        threadId,
        projectId,
        title: "Shared thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const threadEvent = yield* Queue.take(delivered);

      assert.equal(threadEvent.sequence, threadResult.sequence);
      assert.isAbove(threadEvent.sequence, projectEvent.sequence);
      assert.isTrue("aggregateKind" in projectEvent);
      assert.isTrue("event" in threadEvent);
      assert.equal((yield* projects.getById(projectId))._tag, "Some");

      const retainedReceipts = yield* sql<{
        readonly aggregate_kind: string;
        readonly aggregate_id: string;
      }>`
        SELECT aggregate_kind, aggregate_id
        FROM orchestration_command_receipts
        ORDER BY result_sequence ASC
      `;
      assert.deepEqual(retainedReceipts, [
        { aggregate_kind: "project", aggregate_id: projectId },
        { aggregate_kind: "thread", aggregate_id: threadId },
      ]);

      const retiredWrites = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_v2_events) +
          (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS count
      `;
      assert.equal(retiredWrites[0]?.count, 0);
    }),
  );
});

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

const queueResumeDisabledInstanceProjectId = ProjectId.make(
  "project:queue-resume-disabled-instance",
);

const layerQueueResumeDisabledInstanceTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [alternateInstanceId]: { driver: "codex", enabled: true },
      },
      projectSettingsOverrides: {
        [queueResumeDisabledInstanceProjectId]: {
          providerInstances: { [alternateInstanceId]: { enabled: false } },
        },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerQueueResumeDisabledInstanceTest)(
  "queue.resume on a project-disabled instance",
  (it) => {
    it.effect(
      "holds a queued run instead of starting it on an instance the project turned off",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const events = yield* EventSink.EventSinkV2;
          const threadId = ThreadId.make("queue-resume-disabled-instance-thread");
          const queuedModelSelection = {
            instanceId: alternateInstanceId,
            model: "gpt-5.5",
          } satisfies ModelSelection;

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId: queueResumeDisabledInstanceProjectId,
            title: "Queue resume disabled instance",
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
            commandId: CommandId.make(`${threadId}:message:active`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:active`),
            text: "Active",
            attachments: [],
            dispatchMode: { type: "defer_start" },
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:queued`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:queued`),
            text: "Queued",
            attachments: [],
            modelSelection: queuedModelSelection,
            dispatchMode: { type: "queue_after_active" },
          });

          const before = yield* orchestrator.getThreadProjection(threadId);
          const activeRun = before.runs.find((run) => run.status !== "queued")!;
          const queuedRun = before.runs.find((run) => run.status === "queued")!;
          const now = yield* DateTime.now;
          yield* events.write({
            events: [
              {
                id: EventId.make(`${threadId}:active-completed`),
                type: "run.updated",
                threadId,
                runId: activeRun.id,
                occurredAt: now,
                payload: { ...activeRun, status: "completed", completedAt: now },
              },
            ],
          });

          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          });

          const resumed = yield* orchestrator.getThreadProjection(threadId);
          const resumedQueuedRun = resumed.runs.find((run) => run.id === queuedRun.id);
          assert.equal(
            resumedQueuedRun?.status,
            "queued",
            "a disabled instance must not start the queued run",
          );
          assert.isTrue(
            resumedQueuedRun?.queueHeld,
            "a refused resume re-holds the queue instead of leaving it looking resumable",
          );
        }),
    );
  },
);
