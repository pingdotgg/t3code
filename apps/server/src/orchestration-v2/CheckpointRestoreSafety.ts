import type { OrchestrationV2AppThread, OrchestrationV2CheckpointScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread or a side chat. Rewind the conversation without restoring files instead, or delete side chats you no longer need.";

const OTHER_WORKSPACE_RESTORE_MESSAGE =
  "This turn ran in a different worktree, so its files can't be restored into this one. Rewind the conversation without restoring files instead.";

export type CheckpointRestoreRefusal = "shared-workspace" | "other-workspace";

const REFUSAL_MESSAGES: Record<CheckpointRestoreRefusal, string> = {
  "shared-workspace": SHARED_WORKSPACE_RESTORE_MESSAGE,
  "other-workspace": OTHER_WORKSPACE_RESTORE_MESSAGE,
};

export const checkpointRestoreRefusalMessage = (refusal: CheckpointRestoreRefusal) =>
  REFUSAL_MESSAGES[refusal];

// Check isolation at admission and rollback; checkpoints restore whole checkouts, which may become shared.
export const checkpointRestoreRefusal = Effect.fn("orchestrationV2.checkpointRestoreRefusal")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    dependencies: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly projections: ProjectionStoreV2["Service"];
      readonly projects: ProjectStore.ProjectStoreV2["Service"];
      readonly path: Path.Path;
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
    let shared = worktreePath == null;
    if (!shared && worktreePath !== null) {
      // Storage cleanup may have removed the worktree; rollback recreates it.
      const resolve = (target: string) =>
        fileSystem.realPath(target).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            (_error) => Effect.succeed(path.resolve(target)),
          ),
        );
      const cwd = yield* resolve(scope.cwd);
      if (cwd !== (yield* resolve(worktreePath))) return "other-workspace" as const;
      if (!shared) {
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
            const { turnItems } = yield* projections.getThreadRecords(
              otherThread.id,
              ["turnItems"],
              {
                turnItemTypes: ["command_execution", "file_change", "dynamic_tool"],
              },
            );
            if (turnItems.length === 0) continue;
          }
          const other = yield* projections.getCheckpointContext(otherThread.id);
          // A thread keeps a root scope per workspace it used; only its newest is where it works now.
          const runOrdinals = new Map(other.runs.map((run) => [run.id, run.ordinal]));
          const scopeRunOrdinal = (candidate: (typeof other.checkpointScopes)[number]) =>
            (candidate.runId === null ? undefined : runOrdinals.get(candidate.runId)) ?? 0;
          const latestRootRunOrdinal = Math.max(
            -1,
            ...other.checkpointScopes
              .filter((candidate) => candidate.kind === "root_run")
              .map(scopeRunOrdinal),
          );
          const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
          const paths = [
            otherThread.worktreePath,
            ...other.checkpointScopes
              .filter(
                (candidate) =>
                  candidate.kind !== "root_run" ||
                  scopeRunOrdinal(candidate) === latestRootRunOrdinal,
              )
              .map((candidate) => candidate.cwd),
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
            if (Option.isNone(project)) return "shared-workspace" as const;
            paths.push(project.value.workspaceRoot);
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
            if (otherCwd !== null && (contains(cwd, otherCwd) || contains(otherCwd, cwd))) {
              shared = true;
              break;
            }
          }
          if (shared) break;
        }
      }
    }
    return shared ? ("shared-workspace" as const) : null;
  },
);
