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

export type WorktreeCheckThread = Pick<ThreadShell, "id" | "worktreePath">;

/** Resolves the worktree path to offer for removal when deleting a thread,
    folding in archived siblings so a worktree they still link isn't treated as
    orphaned. Only fetches when the thread has a worktree. An unavailable
    snapshot cannot prove the worktree is orphaned, so cleanup is skipped. */
export async function resolveOrphanedWorktreePathForDelete(input: {
  readonly threads: ReadonlyArray<WorktreeCheckThread>;
  readonly threadId: ThreadShell["id"];
  readonly fetchArchivedThreads: () => Promise<ReadonlyArray<WorktreeCheckThread> | null>;
}): Promise<string | null> {
  const targetThread = input.threads.find((thread) => thread.id === input.threadId);
  if (!targetThread || !normalizeWorktreePath(targetThread.worktreePath)) {
    return null;
  }

  const archivedThreads = await input.fetchArchivedThreads();
  if (archivedThreads === null) return null;
  return getOrphanedWorktreePathForThread([...input.threads, ...archivedThreads], input.threadId);
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
