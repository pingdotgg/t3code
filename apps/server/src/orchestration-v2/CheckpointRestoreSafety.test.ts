import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2, type ProjectionCheckpointRollbackContext } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect.each([
  "nested",
  "ancestor",
  "provider",
  "sibling",
  "shared-provider",
  "conversation",
  "resumed-child",
] as const)("preserves overlapping workspace files, owner=%s", (owner) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-restore-" });
    const cwd = path.join(parent, "worktree");
    const nested = path.join(cwd, "nested");
    const sibling = path.join(parent, "worktree2");
    yield* fs.makeDirectory(nested, { recursive: true });
    yield* fs.makeDirectory(sibling);
    const otherFile = path.join(nested, "other-thread.txt");
    yield* fs.writeFileString(otherFile, "other thread's uncommitted work");
    const threadId = ThreadId.make("restore-current");
    const otherId = ThreadId.make("restore-other");
    const projectId = ProjectId.make("restore-project");
    const providerThreadId = ProviderThreadId.make("restore-provider");
    const providerSessionId = ProviderSessionId.make("restore-session");
    const instanceId = ProviderInstanceId.make("restore-instance");
    const checkpointId = CheckpointId.make("restore-checkpoint");
    const scopeId = CheckpointScopeId.make("restore-scope");
    const calls: string[] = [];
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId: instanceId,
    };
    const otherThread = {
      id: otherId,
      projectId,
      deletedAt: null,
      lineage: {
        parentThreadId: owner === "resumed-child" ? threadId : null,
        relationshipToParent: owner === "resumed-child" ? "subagent" : null,
        rootThreadId: owner === "resumed-child" ? threadId : otherId,
      },
      status: "completed",
      activeRunId: null,
      activityRunStatus: owner === "resumed-child" ? "starting" : null,
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      worktreePath:
        owner === "resumed-child"
          ? cwd
          : owner === "ancestor" || owner === "conversation"
            ? parent
            : owner === "nested"
              ? nested
              : sibling,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath: cwd,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId, model: "test" },
      },
      providerThread,
      providerSession: undefined,
      providerTurns: [],
      rootNodes: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      staleCheckpoints: [],
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: null },
      scope: { id: scopeId, cwd },
      runsToRollback: [{ id: "later-run", ordinal: 1, status: "completed", rootNodeId: null }],
    } as unknown as ProjectionCheckpointRollbackContext;
    const layerTest = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
          ServerSettings.layerTest(),
          ThreadCommandExecutor.layer,
          IdAllocator.layer,
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedSome({ workspaceRoot: parent } as never),
          }),
          Layer.mock(ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [otherThread] as never,
                archivedThreads: [],
              }),
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpoints: [],
                checkpointScopes: [],
              }),
            getThreadProviderContext: () =>
              Effect.succeed({
                thread: otherThread as never,
                providerThreads: [],
                providerSessions:
                  owner === "provider" || owner === "shared-provider"
                    ? ([
                        {
                          cwd: owner === "shared-provider" ? cwd : nested,
                          status: "running",
                          capabilities: {
                            sessions: {
                              supportsMultipleProviderThreadsPerSession:
                                owner === "shared-provider",
                            },
                          },
                        },
                      ] as never)
                    : [],
              }),
          }),
          Layer.mock(CheckpointServiceV2)({
            restore: () =>
              Effect.gen(function* () {
                calls.push("files");
                yield* fs.remove(otherFile).pipe(Effect.orDie);
              }),
          }),
          Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
          Layer.mock(ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                rollbackThread: () =>
                  Effect.sync(() => {
                    calls.push("provider");
                    return { providerThread };
                  }),
              } as never),
          }),
          Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        ),
      ),
    );
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
      Effect.provide(layerTest),
    );
    const restoreFiles = owner !== "conversation";
    const rejected = !["sibling", "shared-provider", "conversation"].includes(owner);
    if (rejected) {
      const error = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.flip);
      assert.equal(error.reason, "shared-workspace");
      assert.deepEqual(calls, []);
      assert.equal(yield* fs.readFileString(otherFile), "other thread's uncommitted work");
    } else {
      yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
      assert.deepEqual(calls, restoreFiles ? ["provider", "files"] : ["provider"]);
      assert.equal(yield* fs.exists(otherFile), !restoreFiles);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("lets rollback recreate a worktree storage cleanup removed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-v2-restore-removed-" });
    const worktreePath = path.join(parent, "worktree");
    const isolated = yield* isCheckpointRestoreIsolated(
      { id: ThreadId.make("restore-removed"), worktreePath },
      { cwd: worktreePath },
      {
        fileSystem,
        path,
        projections: {
          getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
        } as never,
        projects: {} as never,
      },
    );
    assert.isTrue(isolated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { sideChat: "answering questions", running: false, toolItems: 0, isolated: true },
  { sideChat: "running", running: true, toolItems: 0, isolated: false },
  { sideChat: "after running tools", running: false, toolItems: 1, isolated: false },
] as const)(
  "a side chat $sideChat shares the parent's worktree: $isolated",
  ({ running, toolItems, isolated }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreePath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-v2-restore-side-chat-",
      });
      const parentId = ThreadId.make("restore-side-chat-parent");
      const sideChat = {
        id: ThreadId.make("restore-side-chat"),
        projectId: ProjectId.make("restore-project"),
        deletedAt: null,
        worktreePath,
        activeRunId: running ? "side-chat-run" : null,
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "fork",
          rootThreadId: parentId,
          sideChat: true,
        },
      };
      const result = yield* isCheckpointRestoreIsolated(
        { id: parentId, worktreePath },
        { cwd: worktreePath },
        {
          fileSystem,
          path,
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [sideChat], archivedThreads: [] }),
            getThreadRecords: () =>
              Effect.succeed({
                turnItems: Array.from({ length: toolItems }, () => ({ type: "command_execution" })),
              }),
            getCheckpointContext: () => Effect.succeed({ checkpointScopes: [] }),
            getThreadProviderContext: () => Effect.succeed({ providerSessions: [] }),
          } as never,
          projects: {} as never,
        },
      );
      assert.equal(result, isolated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "completed child", isolated: true },
  { name: "completed native child", isolated: true },
  { name: "native child still running", isolated: false },
  { name: "native child with running tool", isolated: false },
  { name: "native child with active provider", isolated: false },
  { name: "native child with provider background task", isolated: false },
  { name: "native child with parent background task", isolated: false },
  { name: "native child with unrelated parent task", isolated: false },
  { name: "native child with another provider parent task", isolated: true },
  { name: "native child with unattributed parent task", isolated: false },
  { name: "native child grandchild with root background task", isolated: false },
  { name: "missing task record", isolated: false },
  { name: "task belongs to another child", isolated: false },
  { name: "completed child with pending task", isolated: false },
  { name: "grandchild through fork", isolated: false },
  { name: "completed grandchild", isolated: true },
  { name: "archived completed child", isolated: true },
  { name: "unrelated child", isolated: false },
  { name: "sibling with the same root", isolated: false },
  { name: "fork", isolated: false },
  { name: "side chat", isolated: false },
  { name: "running child", isolated: false },
  { name: "starting child", isolated: false },
  { name: "pending request", isolated: false },
  { name: "background work", isolated: false },
  { name: "held queue", isolated: false },
  { name: "failed child", isolated: false },
  { name: "different worktree", isolated: false },
  { name: "missing ancestor", isolated: false },
  { name: "cyclic ancestry", isolated: false },
] as const)("parent file restore with $name: $isolated", ({ name, isolated }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktreePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-child-" });
    const nested = path.join(worktreePath, "nested");
    yield* fileSystem.makeDirectory(nested);
    const parentId = ThreadId.make("restore-parent");
    const childId = ThreadId.make("restore-child");
    const ancestorId = ThreadId.make("restore-ancestor");
    const child = {
      id: childId,
      projectId: ProjectId.make("restore-project"),
      deletedAt: null,
      archivedAt: name === "archived completed child" ? "2026-01-01T00:00:00Z" : null,
      worktreePath: name === "different worktree" ? nested : worktreePath,
      activeRunId: name === "running child" ? "child-run" : null,
      activityRunStatus: name === "starting child" ? "starting" : null,
      latestRunId: name.includes("native child") ? null : "child-run",
      creationSource: name.includes("native child") ? "provider" : "user",
      forkedFrom: { type: "node", nodeId: "child-task" },
      status: name.includes("native child")
        ? "idle"
        : name === "running child"
          ? "running"
          : name === "failed child"
            ? "failed"
            : "completed",
      pendingRuntimeRequest: name === "pending request" ? { id: "approval" } : null,
      pendingBackgroundTasks: name === "background work" ? [{ taskId: "background" }] : [],
      lineage: {
        parentThreadId:
          name === "completed grandchild" ||
          name === "native child grandchild with root background task" ||
          name === "grandchild through fork" ||
          name === "missing ancestor" ||
          name === "cyclic ancestry"
            ? ancestorId
            : name === "unrelated child" || name === "sibling with the same root"
              ? ThreadId.make("another-parent")
              : parentId,
        relationshipToParent: name === "fork" || name === "side chat" ? "fork" : "subagent",
        rootThreadId: parentId,
        sideChat: name === "side chat",
      },
    };
    const ancestor = {
      ...child,
      id: ancestorId,
      forkedFrom: { type: "node", nodeId: "ancestor-task" },
      lineage: {
        ...child.lineage,
        relationshipToParent: name === "grandchild through fork" ? "fork" : "subagent",
        parentThreadId: name === "cyclic ancestry" ? childId : parentId,
      },
    };
    const children =
      name === "completed grandchild" ||
      name === "native child grandchild with root background task" ||
      name === "grandchild through fork" ||
      name === "cyclic ancestry"
        ? [child, ancestor]
        : [child];
    const projections = {
      getShellSnapshot: () =>
        Effect.succeed({
          threads: children.filter((child) => child.archivedAt === null),
          archivedThreads: children.filter((child) => child.archivedAt !== null),
        }),
      getCheckpointContext: () =>
        Effect.succeed({
          checkpointScopes: [],
          runs: name === "held queue" ? [{ status: "queued" }] : [],
        }),
      getThreadProviderContext: () => Effect.succeed({ providerSessions: [] }),
      getThreadRecords: (
        _threadId: unknown,
        _fields: readonly string[],
        filter: { subagentIds?: string[]; turnItemStatuses?: string[] } = {},
      ) =>
        Effect.succeed({
          providerThreads:
            _threadId === parentId &&
            (name.includes("parent") ||
              name === "native child grandchild with root background task") &&
            name.includes("native child")
              ? [
                  {
                    providerInstanceId:
                      name === "native child with another provider parent task"
                        ? "other-provider"
                        : "claude",
                    status: "idle",
                    pendingBackgroundTasks: [
                      {
                        taskId: "background",
                        kind: "command",
                        parentTaskId:
                          name === "native child with unattributed parent task"
                            ? undefined
                            : name === "native child with unrelated parent task"
                              ? "unrelated-task"
                              : "native-task",
                      },
                    ],
                  },
                ]
              : name === "native child with active provider"
                ? [{ status: "active", pendingBackgroundTasks: [] }]
                : name === "native child with provider background task"
                  ? [{ status: "idle", pendingBackgroundTasks: [{ taskId: "background" }] }]
                  : [],
          turnItems:
            name === "side chat" ||
            (filter.turnItemStatuses !== undefined && name === "native child with running tool")
              ? [{ type: "command_execution", status: "running" }]
              : [],
          subagents:
            name === "missing task record"
              ? []
              : [
                  {
                    id: filter.subagentIds?.[0],
                    providerInstanceId: "claude",
                    nativeTaskRef: { nativeId: "native-task" },
                    childThreadId:
                      name === "task belongs to another child"
                        ? "another-child"
                        : filter.subagentIds?.[0] === "ancestor-task"
                          ? ancestorId
                          : childId,
                    origin: name.includes("native child") ? "provider_native" : "app_owned",
                    status:
                      name === "native child still running" ||
                      name === "completed child with pending task"
                        ? "running"
                        : "completed",
                  },
                ],
        }),
    };
    const result = yield* isCheckpointRestoreIsolated(
      { id: parentId, worktreePath },
      { cwd: worktreePath },
      { fileSystem, path, projections: projections as never, projects: {} as never },
    );
    assert.equal(result, isolated);
    if (isolated) {
      // Admission is not the last check: a child resumed before execution must block restore.
      child.activityRunStatus = "starting";
      const resumed = yield* isCheckpointRestoreIsolated(
        { id: parentId, worktreePath },
        { cwd: worktreePath },
        { fileSystem, path, projections: projections as never, projects: {} as never },
      );
      assert.isFalse(resumed);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
