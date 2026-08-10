import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";
import {
  additionalProjectFolderPaths,
  type ProjectFolderSource,
} from "@t3tools/shared/projectFolders";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}

/**
 * The full folder set a thread's agent should see.
 *
 * `cwd` keeps the existing single-root semantics — a worktree replaces the
 * project's primary folder. The project's additional folders are separate trees
 * that a worktree does not shadow, so they pass through unchanged.
 *
 * Kept separate from {@link resolveThreadWorkspaceCwd}, whose callers (title
 * generation, checkpoint scoping) legitimately want exactly one path.
 */
export function resolveThreadWorkspaceFolders(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<ProjectFolderSource & { readonly id: ProjectId }>;
}): {
  readonly cwd: string | undefined;
  readonly additionalDirectories: ReadonlyArray<string>;
} {
  const project = input.projects.find((entry) => entry.id === input.thread.projectId);
  return {
    cwd: input.thread.worktreePath ?? project?.workspaceRoot,
    additionalDirectories: project ? additionalProjectFolderPaths(project) : [],
  };
}
