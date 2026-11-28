import {
  type ManagedPolicyDocument,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProjectTrackedFolder,
  type TaskFolderError,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as LayoutCommandApprovals from "./LayoutCommandApprovals.ts";
import * as LayoutCommandApprovalWrites from "./LayoutCommandApprovalWrites.ts";
import * as TaskFolders from "./TaskFolders.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";

export const taskFoldersTestProjectId = ProjectId.make("project:task-folders");

/** What the mocked stores answer with; a test fills it in once its folders exist. */
export interface TaskFoldersTestState {
  workspaceRoot: string;
  trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
  thread: { worktreePath: string | null; branch: string | null } | null;
  /** Other threads' folders, as removal reads them. */
  threadWorktreePaths?: ReadonlyArray<string>;
  /** Runs after each read of an approval, in the fiber that asked. */
  onApprovalRead?: Effect.Effect<void>;
  /** Runs after each listing of a repository's branches, in the fiber that asked. */
  onBranchListing?: Effect.Effect<void>;
  /** Runs before each layout command starts, while it holds the project's turn. */
  onLayoutCommand?: Effect.Effect<void>;
  /** Runs in place of forgetting a task folder's record. */
  onForget?: Effect.Effect<void, TaskFolderError>;
}

/**
 * The real service and record over real Git, for tests that create and remove worktrees. The
 * workflow service only adds settings lookups on top of the driver, so the driver stands in.
 */
export const layerTaskFoldersWithGit = (
  state: TaskFoldersTestState,
  policy?: ManagedPolicyDocument,
) => {
  const layerWorkflow = Layer.unwrap(
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const succeeds = (cwd: string, args: ReadonlyArray<string>) =>
        git
          .execute({ operation: "task-folders-test", cwd, args, allowNonZeroExit: true })
          .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));
      return Layer.mock(GitWorkflowService.GitWorkflowService)({
        createWorktree: git.createWorktree,
        removeWorktree: git.removeWorktree,
        deleteLocalBranch: git.deleteLocalBranch,
        listLocalBranchNames: (cwd) =>
          git
            .listLocalBranchNames(cwd)
            .pipe(Effect.tap(() => Effect.suspend(() => state.onBranchListing ?? Effect.void))),
        pruneWorktrees: git.pruneWorktrees,
        renameBranch: git.renameBranch,
        fetchWorktreeBaseCommit: git.fetchWorktreeBaseCommit,
        hasCommit: ({ cwd, refName }) =>
          succeeds(cwd, ["rev-parse", "--verify", "--quiet", `${refName}^{commit}`]).pipe(
            Effect.map((commit) => commit !== null),
          ),
        currentBranch: (cwd) => succeeds(cwd, ["symbolic-ref", "--short", "--quiet", "HEAD"]),
      });
    }),
  );
  const project = () => ({
    projectId: taskFoldersTestProjectId,
    title: "Shop",
    hasCustomTitle: false,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    deletedAt: null,
    workspaceRoot: state.workspaceRoot,
    trackedFolders: state.trackedFolders,
  });
  return TaskFolders.layer.pipe(
    Layer.provideMerge(
      Layer.effect(
        TaskFolderStore.TaskFolderStore,
        Effect.map(TaskFolderStore.TaskFolderStore, (store) =>
          TaskFolderStore.TaskFolderStore.of({
            ...store,
            remove: (root) => Effect.suspend(() => state.onForget ?? store.remove(root)),
          }),
        ),
      ).pipe(Layer.provide(TaskFolderStore.layer)),
    ),
    // The write side too: a test approves a command the way a person's client does.
    Layer.provideMerge(
      Layer.merge(
        Layer.effect(
          LayoutCommandApprovals.LayoutCommandApprovals,
          Effect.map(LayoutCommandApprovals.LayoutCommandApprovals, (approvals) =>
            LayoutCommandApprovals.LayoutCommandApprovals.of({
              isApproved: (input) =>
                approvals
                  .isApproved(input)
                  .pipe(
                    Effect.tap(() => Effect.suspend(() => state.onApprovalRead ?? Effect.void)),
                  ),
            }),
          ),
        ).pipe(Layer.provide(LayoutCommandApprovals.layer)),
        LayoutCommandApprovalWrites.layer,
      ),
    ),
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provide(layerWorkflow),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeedSome(project()),
          findActiveByWorkspaceRoot: (workspaceRoot) =>
            Effect.succeed(
              workspaceRoot === state.workspaceRoot ? Option.some(project()) : Option.none(),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadWorktreePaths: () =>
            Effect.succeed(
              (state.threadWorktreePaths ?? []).map((worktreePath, index) => ({
                threadId: ThreadId.make(`thread:bound-${index}`),
                worktreePath,
              })),
            ),
          getThreadShell: () =>
            Effect.succeed(
              state.thread === null
                ? null
                : ({
                    projectId: taskFoldersTestProjectId,
                    ...state.thread,
                  } as OrchestrationV2ThreadShell),
            ),
        }),
        ServerSettings.layerTest(),
        SqlitePersistence.layerMemory,
        Layer.effect(
          VcsProcess.VcsProcess,
          Effect.map(VcsProcess.VcsProcess, (processes) =>
            VcsProcess.VcsProcess.of({
              run: (input) =>
                Effect.suspend(() =>
                  input.operation === "TaskFolders.worktreeLayout"
                    ? (state.onLayoutCommand ?? Effect.void)
                    : Effect.void,
                ).pipe(Effect.andThen(processes.run(input))),
            }),
          ),
        ).pipe(Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)))),
      ),
    ),
  );
};

/**
 * Approves the project's layout commands as its file holds them now, the way the client RPC
 * records a person's approval.
 */
export const approveLayoutCommands = Effect.gen(function* () {
  const taskFolders = yield* TaskFolders.TaskFolders;
  const writes = yield* LayoutCommandApprovalWrites.LayoutCommandApprovalWrites;
  const { commands } = yield* taskFolders.layoutCommands(taskFoldersTestProjectId);
  yield* Effect.forEach(
    commands,
    ({ kind, command }) => writes.set({ projectId: taskFoldersTestProjectId, kind, command }),
    { discard: true },
  );
});

/** Withdraws the approval of the project's `create` command, as Revoke in its settings does. */
export const revokeCreateCommand = Effect.flatMap(
  LayoutCommandApprovalWrites.LayoutCommandApprovalWrites,
  (writes) => writes.set({ projectId: taskFoldersTestProjectId, kind: "create", command: null }),
);
