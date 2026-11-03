import type { OrchestrationV2AppThread, OrchestrationV2CheckpointScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { TaskFolderStore } from "../workspace/TaskFolders.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread or a side chat. Rewind the conversation without restoring files instead, or delete side chats you no longer need.";

// Check isolation at admission and rollback; checkpoints restore whole checkouts, which may become shared.
export const isCheckpointRestoreIsolated = Effect.fn("orchestrationV2.isCheckpointRestoreIsolated")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    dependencies: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly projections: ProjectionStoreV2["Service"];
      readonly projects: ProjectStore.ProjectStoreV2["Service"];
      readonly path: Path.Path;
      /** Without it, a repository scope only has to be a checkout other than its tracked folder. */
      readonly taskFolders?: Pick<TaskFolderStore["Service"], "findContaining">;
    },
  ) {
    const { fileSystem, projections, projects, path } = dependencies;
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };
    const worktreePath = thread.worktreePath;
    if (worktreePath == null) return false;
    // Storage cleanup may have removed the worktree; rollback recreates it.
    const resolve = (target: string) =>
      fileSystem.realPath(target).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          (_error) => Effect.succeed(path.resolve(target)),
        ),
      );
    const cwd = yield* resolve(scope.cwd);
    if (cwd !== (yield* resolve(worktreePath))) return false;

    // Every repo of a multi-repo thread must be a checkout this thread's task folder owns.
    const repositoryScopes = (yield* projections.getCheckpointContext(
      thread.id,
    )).checkpointScopes.filter((candidate) => candidate.kind === "repository");
    const ownCwds = [cwd];
    if (repositoryScopes.length > 0) {
      const taskFolderRoot =
        dependencies.taskFolders === undefined
          ? undefined
          : yield* dependencies.taskFolders.findContaining(cwd).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(null),
                  onSome: (record) => resolve(record.root),
                }),
              ),
            );
      if (taskFolderRoot === null) return false;
      for (const repositoryScope of repositoryScopes) {
        const repositoryCwd = yield* resolve(repositoryScope.cwd);
        if (
          repositoryScope.repositoryPath != null &&
          repositoryCwd === (yield* resolve(repositoryScope.repositoryPath))
        ) {
          return false;
        }
        if (taskFolderRoot !== undefined && !contains(taskFolderRoot, repositoryCwd)) return false;
        ownCwds.push(repositoryCwd);
      }
    }

    const overlaps = (otherCwd: string) =>
      ownCwds.some((ownCwd) => contains(ownCwd, otherCwd) || contains(otherCwd, ownCwd));
    const shell = yield* projections.getShellSnapshot();
    const checkedPaths = new Set<string>();
    for (const otherThread of [...shell.threads, ...shell.archivedThreads]) {
      if (otherThread.id === thread.id || otherThread.deletedAt !== null) continue;
      // An idle side chat that only answered questions never touched the shared worktree.
      if (
        otherThread.lineage.sideChat === true &&
        otherThread.activeRunId === null &&
        otherThread.worktreePath === worktreePath
      ) {
        const { turnItems } = yield* projections.getThreadRecords(otherThread.id, ["turnItems"], {
          turnItemTypes: ["command_execution", "file_change", "dynamic_tool"],
        });
        if (turnItems.length === 0) continue;
      }
      const other = yield* projections.getCheckpointContext(otherThread.id);
      const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
      const paths = [
        otherThread.worktreePath,
        ...other.checkpointScopes.map((candidate) => candidate.cwd),
        // Errored sessions can still stream. Shared sessions retain another thread's opening cwd;
        // turn worktrees and project roots are already covered here.
        ...providerContext.providerSessions
          .filter(
            (session) =>
              session.status !== "stopped" &&
              !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
          )
          .map((session) => session.cwd),
      ].filter((value): value is string => value !== null);
      if (otherThread.worktreePath === null) {
        const project = yield* projects.get(otherThread.projectId, { includeDeleted: true });
        if (Option.isNone(project)) return false;
        // A local thread reaches its tracked folders before its first turn records their scopes.
        paths.push(
          project.value.workspaceRoot,
          ...project.value.trackedFolders.map((folder) => folder.path),
        );
      }
      for (const candidate of paths) {
        if (checkedPaths.has(candidate)) continue;
        checkedPaths.add(candidate);
        const otherCwd = yield* fileSystem.realPath(candidate).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            (_error) => Effect.succeed(null),
          ),
        );
        if (otherCwd !== null && overlaps(otherCwd)) return false;
      }
    }
    return true;
  },
);
