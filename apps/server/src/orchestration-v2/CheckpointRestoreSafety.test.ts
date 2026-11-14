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
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import { isCheckpointRestoreIsolated, planCheckpointRestore } from "./CheckpointRestoreSafety.ts";
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
  "repository-worktree",
  ...(symlinksSupported ? (["aliased-repository-worktree"] as const) : []),
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
    const alias = path.join(parent, "alias");
    if (owner === "aliased-repository-worktree") yield* fs.symlink(cwd, alias);
    // A folder thread reused this thread's own checkout as a repository worktree.
    const repositoryAttachment =
      owner === "repository-worktree"
        ? cwd
        : owner === "aliased-repository-worktree"
          ? alias
          : null;
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
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: otherId },
      worktreePath:
        owner === "ancestor" || owner === "conversation"
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
            getThreadRepoWorktreePaths: () =>
              Effect.succeed(
                repositoryAttachment === null
                  ? []
                  : [{ threadId: otherId, title: "Folder", worktreePath: repositoryAttachment }],
              ),
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
          getThreadRepoWorktreePaths: () => Effect.succeed([]),
        } as never,
        projects: {} as never,
      },
    );
    assert.isTrue(isolated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// The service worktree was saved at both turns.
it.effect.each([
  {
    refusal: "the thread worktree's snapshot failed at the target",
    owner: "thread worktree",
    target: "error",
    later: "ready",
    otherAttached: false,
    expected: "workspace-unavailable",
  },
  {
    refusal: "the project folder's snapshot failed after the target",
    owner: "project folder",
    target: "ready",
    later: "error",
    otherAttached: false,
    expected: "shared-workspace",
  },
  {
    refusal: "the project folder's snapshot failed at the target and a later turn edited it",
    owner: "project folder",
    target: "error",
    later: "ready",
    otherAttached: false,
    laterFolderEdit: true,
    expected: "shared-workspace",
  },
  {
    refusal: "the project folder changed after the target but no later turn listed its files",
    owner: "project folder",
    target: "ready",
    later: "ready",
    otherAttached: false,
    workspaceChanged: true,
    expected: "shared-workspace",
  },
  {
    refusal: "another thread has the removed service worktree attached",
    owner: "project folder",
    target: "ready",
    later: "ready",
    otherAttached: true,
    expected: "shared-repository",
  },
  ...(symlinksSupported
    ? ([
        {
          refusal: "another thread has the removed service worktree attached through a link",
          owner: "project folder",
          target: "ready",
          later: "ready",
          otherAttached: true,
          attachedThroughLink: true,
          expected: "shared-repository",
        },
      ] as const)
    : []),
] as const)(
  "refuses file restore when $refusal",
  ({ owner, target: targetStatus, later, otherAttached, expected, ...row }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-v2-restore-error-" });
      const worktreePath = path.join(parent, "worktree");
      const scopeId = CheckpointScopeId.make("restore-error-scope");
      const repository = {
        repository: "service",
        repositoryPath: path.join(parent, "service"),
        worktreePath: path.join(parent, "service-work"),
        branch: "work",
        pathPrefix: "service",
        ref: "refs/t3/test/service",
        status: "ready",
      };
      const file = (filePath: string) => ({
        path: filePath,
        kind: "modified",
        additions: 1,
        deletions: 1,
      });
      const checkpoint = (
        ordinal: number,
        workspaceStatus: "ready" | "error",
        folderEdit = false,
      ) =>
        ({
          id: CheckpointId.make(`restore-error-checkpoint-${ordinal}`),
          scopeId,
          status: "ready",
          workspaceStatus,
          ordinalWithinScope: ordinal,
          ref: `refs/t3/test/workspace-${ordinal}`,
          repositories: [repository],
          files: [file("service/index.ts"), ...(folderEdit ? [file("README.md")] : [])],
        }) as never;
      const target = checkpoint(1, targetStatus);
      let attachedPath = repository.worktreePath;
      if ("attachedThroughLink" in row) {
        yield* fileSystem.symlink(parent, path.join(parent, "link"));
        attachedPath = path.join(parent, "link", "service-work");
      }
      const plan = yield* planCheckpointRestore(
        {
          thread: {
            id: ThreadId.make("restore-error"),
            worktreePath: owner === "thread worktree" ? worktreePath : null,
            repoWorktrees: [],
          },
          scope: { id: scopeId, cwd: worktreePath },
          checkpoint: target,
          checkpoints: [target, checkpoint(2, later, "laterFolderEdit" in row)],
        },
        {
          fileSystem,
          path,
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
            // The service worktree folder does not exist.
            getThreadRepoWorktreePaths: () =>
              Effect.succeed(
                otherAttached
                  ? [
                      {
                        threadId: ThreadId.make("other-thread"),
                        worktreePath: attachedPath,
                      },
                    ]
                  : [],
              ),
          } as never,
          projects: {} as never,
          workspaceChanged: () => Effect.succeed("workspaceChanged" in row),
        },
      );
      assert.equal(plan._tag, expected);
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
            getThreadRepoWorktreePaths: () => Effect.succeed([]),
          } as never,
          projects: {} as never,
        },
      );
      assert.equal(result, isolated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
