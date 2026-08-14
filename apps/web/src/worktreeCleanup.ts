import type { ThreadShell } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

/**
 * Worktrees that nothing would point at once every thread in `threadIds` is
 * gone. Used to ask the worktree question once for a whole batch instead of
 * once per thread — a path only counts when every thread linked to it is
 * inside the batch, matching what the per-thread check lands on as the
 * deletions actually run.
 */
export function getOrphanedWorktreePathsForThreads(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadIds: ReadonlySet<ThreadShell["id"]>,
): ReadonlyArray<string> {
  const survivingPaths = new Set<string>();
  for (const thread of threads) {
    if (threadIds.has(thread.id)) {
      continue;
    }
    const path = normalizeWorktreePath(thread.worktreePath);
    if (path) {
      survivingPaths.add(path);
    }
  }

  const orphaned: string[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    if (!threadIds.has(thread.id)) {
      continue;
    }
    const path = normalizeWorktreePath(thread.worktreePath);
    if (!path || survivingPaths.has(path) || seen.has(path)) {
      continue;
    }
    seen.add(path);
    orphaned.push(path);
  }
  return orphaned;
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
