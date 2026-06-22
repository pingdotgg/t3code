import { assert, it, vi } from "@effect/vitest";
import {
  EventId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { OrchestratorDispatchError, type OrchestratorV2DispatchResult } from "./Orchestrator.ts";
import { emptyProjection } from "./ProjectionStore.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const projectId = ProjectId.make("project_launch_test");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

function projectionFor(threadId: ThreadId): OrchestrationV2ThreadProjection {
  const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
  const event = {
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId,
      title: "Thread",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    },
  } satisfies Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>;
  return emptyProjection(event);
}

const makeLayer = (options?: { readonly failCreate?: boolean; readonly failSetup?: boolean }) => {
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
  const dispatch = vi.fn(
    (
      command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
    ): Effect.Effect<OrchestratorV2DispatchResult, OrchestratorDispatchError> => {
      if (command.type === "thread.metadata.update") {
        const existing = projections.get(command.threadId);
        if (existing === undefined) return Effect.die("missing existing projection");
        projections.set(command.threadId, {
          ...existing,
          thread: {
            ...existing.thread,
            ...(command.title === undefined ? {} : { title: command.title }),
            ...(command.branch === undefined ? {} : { branch: command.branch }),
            ...(command.worktreePath === undefined ? {} : { worktreePath: command.worktreePath }),
          },
        });
        return Effect.succeed({ sequence: 1, storedEvents: [] });
      }
      if (command.type !== "thread.create") return Effect.die("unexpected command");
      if (options?.failCreate) {
        return Effect.fail(
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "create failed",
          }),
        );
      }
      const projection = projectionFor(command.threadId);
      projections.set(command.threadId, {
        ...projection,
        thread: {
          ...projection.thread,
          title: command.title,
          branch: command.branch,
          worktreePath: command.worktreePath,
        },
      });
      return Effect.succeed({ sequence: 1, storedEvents: [] });
    },
  );
  const createWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[0]) =>
      Effect.succeed({
        worktree: { path: "/repo-worktrees/feature", refName: "feature", headSha: "abc" },
      } as never),
  );
  const removeWorktree = vi.fn(() => Effect.void);
  const fetchRemote = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["fetchRemote"]>[0]) =>
      Effect.void,
  );
  const resolveRemoteTrackingCommit = vi.fn(
    (
      _input: Parameters<
        GitWorkflow.GitWorkflowService["Service"]["resolveRemoteTrackingCommit"]
      >[0],
    ) => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
  );
  const runForThread = vi.fn(() =>
    options?.failSetup
      ? Effect.fail(
          new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
            threadId: "thread",
            worktreePath: "/repo-worktrees/feature",
            operation: "openTerminal",
            cause: "setup failed",
          }),
        )
      : Effect.succeed({ status: "no-script" as const }),
  );
  const sendToThread = vi.fn(() =>
    Effect.succeed({} as ThreadManagement.ThreadManagementSendResult),
  );

  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      fetchRemote,
      removeWorktree,
      resolveRemoteTrackingCommit,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
      generateBranchName: () => Effect.succeed({ branch: "generated-branch" }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch,
      getThreadProjection: (threadId) =>
        projections.has(threadId)
          ? Effect.succeed(projections.get(threadId)!)
          : Effect.die("missing projection"),
      sendToThread,
    }),
    IdAllocator.layer,
  );
  return {
    layer: ThreadLaunch.layer.pipe(
      Layer.provideMerge(dependencies),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
    dispatch,
    fetchRemote,
    createWorktree,
    projections,
    removeWorktree,
    resolveRemoteTrackingCommit,
    runForThread,
    sendToThread,
  };
};

it.effect("persists root-workspace launches and returns the committed workflow on retry", () => {
  const test = makeLayer();
  return Effect.gen(function* () {
    const service = yield* ThreadLaunch.ThreadLaunchService;
    const input = {
      commandId: CommandId.make("command_launch_root"),
      projectId,
      title: "Thread",
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      workspaceStrategy: { type: "root" as const },
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const first = yield* service.launch(input);
    const retry = yield* service.launch(input);
    assert.equal(first.threadId, retry.threadId);
    assert.isFalse(first.resumed);
    assert.isTrue(retry.resumed);
    assert.equal(test.dispatch.mock.calls.length, 1);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "generates first-run title and branch, runs setup once, and sends the initial message",
  () => {
    const test = makeLayer();
    return Effect.gen(function* () {
      const service = yield* ThreadLaunch.ThreadLaunchService;
      const input = {
        commandId: CommandId.make("command_launch_generated"),
        projectId,
        title: "New thread",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        workspaceStrategy: { type: "worktree" as const, baseRef: "main" },
        initialMessage: { text: "Build the feature", attachments: [] },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      yield* service.launch(input);
      yield* service.launch(input);
      const createCommand = test.dispatch.mock.calls[0]?.[0];
      assert.equal(createCommand?.type, "thread.create");
      if (createCommand?.type === "thread.create") {
        assert.equal(createCommand.title, "Generated title");
        assert.equal(createCommand.branch, "feature");
      }
      assert.equal(test.runForThread.mock.calls.length, 1);
      assert.equal(test.sendToThread.mock.calls.length, 1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("preserves an existing worktree when launching a new thread", () => {
  const test = makeLayer();
  return Effect.gen(function* () {
    const service = yield* ThreadLaunch.ThreadLaunchService;
    const result = yield* service.launch({
      commandId: CommandId.make("command_launch_existing_worktree"),
      threadId: ThreadId.make("thread_existing_worktree"),
      projectId,
      title: "Thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: "/repo-worktrees/existing",
        branch: "existing",
      },
      createdBy: "user",
      creationSource: "web",
    });
    assert.equal(result.projection.thread.worktreePath, "/repo-worktrees/existing");
    assert.equal(result.projection.thread.branch, "existing");
    assert.equal(test.createWorktree.mock.calls.length, 0);
    assert.equal(test.removeWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("fetches and resolves origin before provisioning an origin-based worktree", () => {
  const test = makeLayer();
  return Effect.gen(function* () {
    const service = yield* ThreadLaunch.ThreadLaunchService;
    yield* service.launch({
      commandId: CommandId.make("command_launch_origin_worktree"),
      projectId,
      title: "Thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: {
        type: "worktree",
        baseRef: "main",
        branch: "feature",
        startFromOrigin: true,
      },
      createdBy: "user",
      creationSource: "web",
    });
    assert.deepEqual(test.fetchRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "origin",
    });
    assert.deepEqual(test.resolveRemoteTrackingCommit.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "main",
      fallbackRemoteName: "origin",
    });
    assert.deepEqual(test.createWorktree.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "remote-main-sha",
      newRefName: "feature",
      baseRefName: "main",
      path: null,
    });
  }).pipe(Effect.provide(test.layer));
});

it.effect("provisions a worktree for an existing empty thread before sending", () => {
  const test = makeLayer();
  const threadId = ThreadId.make("thread_existing_empty");
  test.projections.set(threadId, projectionFor(threadId));
  return Effect.gen(function* () {
    const service = yield* ThreadLaunch.ThreadLaunchService;
    yield* service.launch({
      commandId: CommandId.make("command_launch_existing_empty"),
      threadId,
      reuseExistingThread: true,
      projectId,
      title: "Thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree", baseRef: "main", branch: "feature" },
      initialMessage: { text: "Implement it", attachments: [] },
      createdBy: "user",
      creationSource: "web",
    });
    const updateCommand = test.dispatch.mock.calls.find(
      ([command]) => command.type === "thread.metadata.update",
    )?.[0];
    assert.equal(updateCommand?.type, "thread.metadata.update");
    if (updateCommand?.type === "thread.metadata.update") {
      assert.equal(updateCommand.worktreePath, "/repo-worktrees/feature");
      assert.equal(updateCommand.branch, "feature");
    }
    assert.equal(test.sendToThread.mock.calls.length, 1);
  }).pipe(Effect.provide(test.layer));
});

it.effect("removes a new worktree and does not create a thread when setup fails", () => {
  const test = makeLayer({ failSetup: true });
  return Effect.gen(function* () {
    const service = yield* ThreadLaunch.ThreadLaunchService;
    yield* service
      .launch({
        commandId: CommandId.make("command_launch_setup_failure"),
        projectId,
        title: "Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "feature" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.equal(test.removeWorktree.mock.calls.length, 1);
    assert.equal(test.dispatch.mock.calls.length, 0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("compensates a newly-created worktree when thread creation fails", () => {
  const test = makeLayer({ failCreate: true });
  return Effect.gen(function* () {
    const service = yield* ThreadLaunch.ThreadLaunchService;
    yield* service
      .launch({
        commandId: CommandId.make("command_launch_worktree"),
        projectId,
        title: "Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "feature" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.equal(test.createWorktree.mock.calls.length, 1);
    assert.equal(test.removeWorktree.mock.calls.length, 1);
  }).pipe(Effect.provide(test.layer));
});
