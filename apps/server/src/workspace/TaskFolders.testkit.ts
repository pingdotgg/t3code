import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProjectTrackedFolder,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskFolders from "./TaskFolders.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";

export const taskFoldersTestProjectId = ProjectId.make("project:task-folders");

/** What the mocked stores answer with; a test fills it in once its folders exist. */
export interface TaskFoldersTestState {
  workspaceRoot: string;
  trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
  thread: { worktreePath: string | null; branch: string | null } | null;
}

/**
 * The real service and record over real Git, for tests that create and remove worktrees. The
 * workflow service only adds settings lookups on top of the driver, so the driver stands in.
 */
export const layerTaskFoldersWithGit = (state: TaskFoldersTestState) => {
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
        listLocalBranchNames: git.listLocalBranchNames,
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
    Layer.provideMerge(TaskFolderStore.layer),
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
      ),
    ),
  );
};
