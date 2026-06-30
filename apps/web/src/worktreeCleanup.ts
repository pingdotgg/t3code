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

/**
 * Resolve the name to show for a worktree: the user-assigned label if one exists
 * for this path, otherwise the path-derived display name. The caller resolves
 * the custom label using the worktree's environment and path.
 *
 * Use this everywhere a worktree name renders so the UI stays consistent.
 */
export function worktreeDisplayName(
  worktreePath: string,
  customLabel: string | null | undefined,
): string {
  const trimmedLabel = customLabel?.trim();
  if (trimmedLabel && trimmedLabel.length > 0) {
    return trimmedLabel;
  }
  return formatWorktreePathForDisplay(worktreePath);
}

export function formatWorktreeDeleteConfirmation(
  worktreePath: string,
  customLabel: string | null | undefined,
): string {
  return [
    "This thread is the only one linked to this worktree:",
    `Name: ${worktreeDisplayName(worktreePath, customLabel)}`,
    `Path: ${worktreePath}`,
    "",
    "Delete the worktree too?",
  ].join("\n");
}
