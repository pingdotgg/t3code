import * as Encoding from "effect/Encoding";
import {
  CheckpointRef,
  ProjectId,
  type OrchestrationThreadWorktree,
  type ThreadId,
} from "@t3tools/contracts";

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
    readonly worktrees?: ReadonlyArray<OrchestrationThreadWorktree> | undefined;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly repoRoots?: ReadonlyArray<string> | undefined;
  }>;
}): string | undefined {
  // In isolated mode prefer the per-root worktree copies (Phase 4 / D3): anchor
  // on the worktree of the workspace root if present, otherwise the first.
  const project = input.projects.find((candidate) => candidate.id === input.thread.projectId);
  const worktrees = input.thread.worktrees ?? [];
  if (worktrees.length > 0) {
    const anchor =
      (project ? worktrees.find((entry) => entry.repoRoot === project.workspaceRoot) : undefined) ??
      worktrees[0];
    if (anchor) {
      return anchor.worktreePath;
    }
  }

  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  if (!project) return undefined;
  if (project.repoRoots && project.repoRoots.length > 0) {
    return project.repoRoots[0];
  }
  return project.workspaceRoot;
}

/**
 * Resolve the full ordered set of working directories a thread's git
 * operations (checkpoint capture, diff, status, restore) should fan out over.
 *
 * Multi-repo projects checkpoint/diff every repo root, not just the first.
 * In isolated (worktree) mode the thread carries a per-root worktree map
 * (Phase 4 / D3); git operations run against the isolated copies, one per root.
 * Falls back to the legacy single `worktreePath`, then `repoRoots`, then
 * `[workspaceRoot]` when no repo roots are recorded (single-root projects and
 * pre-migration data), preserving today's single-root behavior.
 */
export function resolveThreadRepoRoots(input: {
  readonly worktreePath: string | null;
  readonly worktrees?: ReadonlyArray<OrchestrationThreadWorktree> | undefined;
  readonly repoRoots: ReadonlyArray<string>;
  readonly workspaceRoot: string;
}): ReadonlyArray<string> {
  const worktrees = input.worktrees ?? [];
  if (worktrees.length > 0) {
    return worktrees.map((entry) => entry.worktreePath);
  }
  if (input.worktreePath) {
    return [input.worktreePath];
  }
  if (input.repoRoots.length > 0) {
    return input.repoRoots;
  }
  return [input.workspaceRoot];
}
