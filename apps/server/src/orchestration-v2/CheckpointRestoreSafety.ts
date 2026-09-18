import type { OrchestrationV2AppThread, OrchestrationV2CheckpointScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";

export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.";

// A checkpoint snapshots the whole checkout. Check at command admission and
// again before provider rollback so a newly shared worktree is rejected too.
export const isCheckpointRestoreIsolated = Effect.fn("orchestrationV2.isCheckpointRestoreIsolated")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    dependencies: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly projections: ProjectionStoreV2["Service"];
      readonly projects: ProjectionProjects.ProjectionProjectRepository["Service"];
      readonly path: Path.Path;
    },
  ) {
    const { fileSystem, projections, projects, path } = dependencies;
    const worktreePath = thread.worktreePath;
    let shared = worktreePath == null;
    if (!shared && worktreePath !== null) {
      const cwd = yield* fileSystem.realPath(scope.cwd);
      const worktreeCwd = yield* fileSystem.realPath(worktreePath);
      shared = cwd !== worktreeCwd;
      if (!shared) {
        const shell = yield* projections.getShellSnapshot();
        const checkedPaths = new Set<string>();
        for (const otherThread of [...shell.threads, ...shell.archivedThreads]) {
          if (otherThread.id === thread.id || otherThread.deletedAt !== null) continue;
          const other = yield* projections.getCheckpointContext(otherThread.id);
          const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
          const paths = [
            otherThread.worktreePath,
            ...other.checkpointScopes.map((candidate) => candidate.cwd),
            // A failed turn can leave an errored session with a live event stream.
            ...providerContext.providerSessions
              .filter((session) => session.status !== "stopped")
              .map((session) => session.cwd),
          ].filter((value): value is string => value !== null);
          if (otherThread.worktreePath === null) {
            const project = yield* projects.getById({ projectId: otherThread.projectId });
            if (Option.isNone(project)) return false;
            paths.push(project.value.workspaceRoot);
          }
          for (const candidate of paths) {
            if (checkedPaths.has(candidate)) continue;
            checkedPaths.add(candidate);
            const otherCwd = yield* fileSystem
              .realPath(candidate)
              .pipe(
                Effect.catch((error) =>
                  error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
                ),
              );
            const contains = (parent: string, child: string) => {
              const relative = path.relative(parent, child);
              return (
                relative === "" ||
                (!path.isAbsolute(relative) &&
                  relative !== ".." &&
                  !relative.startsWith(`..${path.sep}`))
              );
            };
            if (otherCwd !== null && (contains(cwd, otherCwd) || contains(otherCwd, cwd))) {
              shared = true;
              break;
            }
          }
          if (shared) break;
        }
      }
    }
    return !shared;
  },
);
