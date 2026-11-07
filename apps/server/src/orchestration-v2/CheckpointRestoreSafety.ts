import type {
  OrchestrationV2AppThread,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import {
  type CheckpointRepositoryIdentity,
  checkpointWorkspaceFiles,
  checkpointWorkspaceStatus,
} from "./CheckpointService.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type * as ProjectStore from "./ProjectStore.ts";

export const SHARED_WORKSPACE_RESTORE_MESSAGE =
  "File restore requires an isolated worktree. This workspace may contain changes from another thread or a side chat. Rewind the conversation without restoring files instead, or delete side chats you no longer need.";

export const sharedRepositoryRestoreMessage = (
  repository: Pick<CheckpointRepositoryIdentity, "repository" | "worktreePath">,
) =>
  `Another thread also works in the ${repository.repository} worktree at ${repository.worktreePath}, so files can't be restored. Rewind the conversation without restoring files instead.`;

interface RestoreSafetyDependencies {
  readonly fileSystem: FileSystem.FileSystem;
  readonly projections: ProjectionStoreV2["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly path: Path.Path;
}

/**
 * Real paths every other thread may write in: its workspace, its checkpoint
 * scopes, live sessions, and its repository worktrees. Null when a thread's
 * project is gone, so its workspace is unknown.
 */
const otherThreadPaths = Effect.fn("orchestrationV2.otherThreadPaths")(function* (
  thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
  dependencies: RestoreSafetyDependencies,
) {
  const { fileSystem, projections, projects } = dependencies;
  const candidates = new Set<string>();
  const shell = yield* projections.getShellSnapshot();
  for (const otherThread of [...shell.threads, ...shell.archivedThreads]) {
    if (otherThread.id === thread.id || otherThread.deletedAt !== null) continue;
    // An idle side chat that only answered questions never touched the shared worktree.
    if (
      otherThread.lineage.sideChat === true &&
      otherThread.activeRunId === null &&
      otherThread.worktreePath === thread.worktreePath
    ) {
      const { turnItems } = yield* projections.getThreadRecords(otherThread.id, ["turnItems"], {
        turnItemTypes: ["command_execution", "file_change", "dynamic_tool"],
      });
      if (turnItems.length === 0) continue;
    }
    const other = yield* projections.getCheckpointContext(otherThread.id);
    const providerContext = yield* projections.getThreadProviderContext(otherThread.id);
    for (const candidate of [
      otherThread.worktreePath,
      ...other.checkpointScopes.map((scope) => scope.cwd),
      // Errored sessions can still stream. Shared sessions retain another thread's opening cwd;
      // turn worktrees and project roots are already covered here.
      ...providerContext.providerSessions
        .filter(
          (session) =>
            session.status !== "stopped" &&
            !session.capabilities.sessions.supportsMultipleProviderThreadsPerSession,
        )
        .map((session) => session.cwd),
    ]) {
      if (candidate !== null) candidates.add(candidate);
    }
    if (otherThread.worktreePath === null) {
      const project = yield* projects.get(otherThread.projectId, { includeDeleted: true });
      if (Option.isNone(project)) return null;
      candidates.add(project.value.workspaceRoot);
    }
  }
  // A folder thread can attach another thread's own checkout as a repository worktree.
  for (const attachment of yield* projections.getThreadRepoWorktreePaths()) {
    if (attachment.threadId !== thread.id) candidates.add(attachment.worktreePath);
  }
  const resolved: Array<string> = [];
  for (const candidate of candidates) {
    const real = yield* fileSystem.realPath(candidate).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        (_error) => Effect.succeed(null),
      ),
    );
    if (real !== null) resolved.push(real);
  }
  return resolved;
});

const restoreIsolation = Effect.fn("orchestrationV2.restoreIsolation")(function* (
  thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
  targets: {
    readonly workspace: Pick<OrchestrationV2CheckpointScope, "cwd"> | null;
    readonly repositories: ReadonlyArray<CheckpointRepositoryIdentity>;
  },
  dependencies: RestoreSafetyDependencies,
) {
  const { fileSystem, path } = dependencies;
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  // Storage cleanup may have removed a worktree; rollback recreates it.
  const resolve = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        (_error) => Effect.succeed(path.resolve(target)),
      ),
    );
  // A checkpoint snapshots the whole checkout, so only the thread's own worktree is restorable.
  let workspaceCwd: string | null = null;
  let workspaceIsolated = targets.workspace === null ? null : thread.worktreePath != null;
  if (targets.workspace !== null && thread.worktreePath != null) {
    workspaceCwd = yield* resolve(targets.workspace.cwd);
    workspaceIsolated = workspaceCwd === (yield* resolve(thread.worktreePath));
  }
  const repositoryCwds = yield* Effect.forEach(targets.repositories, (repository) =>
    resolve(repository.worktreePath),
  );
  if (workspaceIsolated !== true && repositoryCwds.length === 0) {
    return { workspace: workspaceIsolated, sharedRepository: null };
  }
  const others = yield* otherThreadPaths(thread, dependencies);
  const shared = (cwd: string) =>
    others === null || others.some((other) => contains(cwd, other) || contains(other, cwd));
  if (workspaceIsolated === true && workspaceCwd !== null && shared(workspaceCwd)) {
    workspaceIsolated = false;
  }
  const sharedIndex = repositoryCwds.findIndex(shared);
  return {
    workspace: workspaceIsolated,
    sharedRepository: sharedIndex < 0 ? null : targets.repositories[sharedIndex]!,
  };
});

// Check isolation at admission and rollback; checkpoints restore whole checkouts, which may become shared.
export const isCheckpointRestoreIsolated = Effect.fn("orchestrationV2.isCheckpointRestoreIsolated")(
  function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath">,
    scope: Pick<OrchestrationV2CheckpointScope, "cwd">,
    dependencies: RestoreSafetyDependencies,
  ) {
    const isolation = yield* restoreIsolation(
      thread,
      { workspace: scope, repositories: [] },
      dependencies,
    );
    return isolation.workspace === true;
  },
);

/**
 * Repository worktrees whose files a rollback to `targetOrdinal` must
 * restore: the ones later checkpoints captured, detached since or not, and
 * the ones attached now. The current attachment's identity wins.
 */
export function participatingRepositories(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "repoWorktrees">;
  readonly scope: Pick<OrchestrationV2CheckpointScope, "id" | "cwd">;
  readonly checkpoints: ReadonlyArray<
    Pick<OrchestrationV2Checkpoint, "scopeId" | "status" | "ordinalWithinScope" | "repositories">
  >;
  readonly targetOrdinal: number;
}): ReadonlyArray<CheckpointRepositoryIdentity> {
  const byWorktree = new Map<string, CheckpointRepositoryIdentity>();
  const later = input.checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.scopeId === input.scope.id &&
        checkpoint.status !== "stale" &&
        checkpoint.ordinalWithinScope > input.targetOrdinal,
    )
    .toSorted((left, right) => left.ordinalWithinScope - right.ordinalWithinScope);
  for (const checkpoint of later) {
    for (const entry of checkpoint.repositories ?? []) {
      byWorktree.set(entry.worktreePath, {
        repository: entry.repository,
        repositoryPath: entry.repositoryPath,
        worktreePath: entry.worktreePath,
        branch: entry.branch,
      });
    }
  }
  for (const attached of input.thread.repoWorktrees ?? []) {
    // The workspace snapshot already covers a checkout the thread works in itself.
    if (attached.worktreePath === input.scope.cwd) continue;
    byWorktree.set(attached.worktreePath, {
      repository: attached.repository,
      repositoryPath: attached.repositoryPath,
      worktreePath: attached.worktreePath,
      branch: attached.branch,
    });
  }
  return [...byWorktree.values()];
}

export type CheckpointRestorePlan =
  | {
      readonly _tag: "restore";
      readonly workspace: boolean;
      /** The thread's own checkout, when it also attached it as a repository worktree. */
      readonly workspaceRepository: CheckpointRepositoryIdentity | null;
      readonly repositories: ReadonlyArray<CheckpointRepositoryIdentity>;
    }
  | { readonly _tag: "shared-workspace" }
  | { readonly _tag: "shared-repository"; readonly repository: CheckpointRepositoryIdentity };

/**
 * What a file restore to `checkpoint` may change. The workspace is restored
 * only when it is the thread's own worktree; a shared one, such as the project
 * folder, blocks the restore only when later turns changed files in it.
 */
export const planCheckpointRestore = Effect.fn("orchestrationV2.planCheckpointRestore")(function* (
  input: {
    readonly thread: Pick<OrchestrationV2AppThread, "id" | "worktreePath" | "repoWorktrees">;
    readonly scope: Pick<OrchestrationV2CheckpointScope, "id" | "cwd">;
    readonly checkpoint: OrchestrationV2Checkpoint;
    readonly checkpoints: ReadonlyArray<
      Pick<
        OrchestrationV2Checkpoint,
        "scopeId" | "status" | "ordinalWithinScope" | "repositories" | "files"
      >
    >;
  },
  dependencies: RestoreSafetyDependencies,
) {
  const targetOrdinal = input.checkpoint.ordinalWithinScope;
  // The workspace snapshot covers a checkout the thread attached under another spelling.
  const realPathOr = (target: string) =>
    dependencies.fileSystem
      .realPath(target)
      .pipe(Effect.orElseSucceed(() => dependencies.path.resolve(target)));
  const workspaceCwd = yield* realPathOr(input.scope.cwd);
  const repositories = yield* Effect.filter(
    participatingRepositories({ ...input, targetOrdinal }),
    (repository) =>
      realPathOr(repository.worktreePath).pipe(Effect.map((real) => real !== workspaceCwd)),
  );
  const workspaceReady = checkpointWorkspaceStatus(input.checkpoint) === "ready";
  const isolation = yield* restoreIsolation(
    input.thread,
    { workspace: workspaceReady ? input.scope : null, repositories },
    dependencies,
  );
  if (workspaceReady && isolation.workspace !== true) {
    const workspaceChangedLater = input.checkpoints.some(
      (checkpoint) =>
        checkpoint.scopeId === input.scope.id &&
        checkpoint.status !== "stale" &&
        checkpoint.ordinalWithinScope > targetOrdinal &&
        checkpointWorkspaceFiles(checkpoint).length > 0,
    );
    if (repositories.length === 0 || workspaceChangedLater) {
      return { _tag: "shared-workspace" } satisfies CheckpointRestorePlan;
    }
  }
  if (isolation.sharedRepository !== null) {
    return {
      _tag: "shared-repository",
      repository: isolation.sharedRepository,
    } satisfies CheckpointRestorePlan;
  }
  const workspace = workspaceReady && isolation.workspace === true;
  let workspaceRepository: CheckpointRepositoryIdentity | null = null;
  for (const attached of workspace ? (input.thread.repoWorktrees ?? []) : []) {
    if ((yield* realPathOr(attached.worktreePath)) === workspaceCwd) {
      const { repository, repositoryPath, worktreePath, branch } = attached;
      workspaceRepository = { repository, repositoryPath, worktreePath, branch };
      break;
    }
  }
  return {
    _tag: "restore",
    workspace,
    workspaceRepository,
    repositories,
  } satisfies CheckpointRestorePlan;
});
