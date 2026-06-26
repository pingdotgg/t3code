import type { ThreadShell } from "./types";

/** Minimal thread shape needed to compute orphaned worktrees. */
type WorktreeOwningThread = Pick<ThreadShell, "id" | "worktreePath" | "worktrees">;

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

/**
 * One worktree to remove when a thread is deleted. `repoRoot` is the original
 * repo the worktree branches from (the git cwd for `git worktree remove`); it
 * is `null` for legacy single-worktree threads that predate the per-root map,
 * in which case the caller falls back to the project's cwd.
 */
export interface OrphanedWorktree {
  readonly repoRoot: string | null;
  readonly worktreePath: string;
}

function threadWorktrees(thread: WorktreeOwningThread): OrphanedWorktree[] {
  if (thread.worktrees.length > 0) {
    return thread.worktrees.flatMap((entry) => {
      const worktreePath = normalizeWorktreePath(entry.worktreePath);
      return worktreePath ? [{ repoRoot: entry.repoRoot, worktreePath }] : [];
    });
  }
  const legacy = normalizeWorktreePath(thread.worktreePath);
  return legacy ? [{ repoRoot: null, worktreePath: legacy }] : [];
}

/**
 * The full set of worktrees a thread owns exclusively — every per-root isolated
 * copy (Phase 4 / D3) not shared by another surviving thread. A worktree shared
 * with a sibling thread is left in place. Falls back to the legacy single
 * `worktreePath` for threads created before the per-root map.
 */
export function getOrphanedWorktreesForThread(
  threads: readonly WorktreeOwningThread[],
  threadId: ThreadShell["id"],
): OrphanedWorktree[] {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return [];
  }

  const isSharedWithOtherThread = (worktreePath: string): boolean =>
    threads.some((thread) => {
      if (thread.id === threadId) {
        return false;
      }
      return threadWorktrees(thread).some((entry) => entry.worktreePath === worktreePath);
    });

  return threadWorktrees(targetThread).filter(
    (entry) => !isSharedWithOtherThread(entry.worktreePath),
  );
}

/**
 * Back-compat single-path accessor: the thread's first exclusively-owned
 * worktree path, or null. Prefer {@link getOrphanedWorktreesForThread} to clean
 * up every root.
 */
export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<WorktreeOwningThread>,
  threadId: ThreadShell["id"],
): string | null {
  return getOrphanedWorktreesForThread(threads, threadId)[0]?.worktreePath ?? null;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
