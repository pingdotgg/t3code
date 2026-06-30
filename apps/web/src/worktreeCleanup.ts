import type { VcsManagedWorktree, WorktreeCleanupScope } from "@t3tools/contracts";

import type { ThreadShell } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  // Canonicalize separator style and trailing slashes so paths from different
  // sources (stored thread paths vs. git-reported worktree paths) compare equal.
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
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

export type WorktreeClassification = "active" | "archived-only" | "orphaned";

export interface WorktreeThreadRef {
  worktreePath: string | null;
  isArchived: boolean;
}

export interface ClassifiedWorktree {
  worktree: VcsManagedWorktree;
  classification: WorktreeClassification;
}

export function classifyManagedWorktrees(
  worktrees: readonly VcsManagedWorktree[],
  threadRefs: readonly WorktreeThreadRef[],
): ClassifiedWorktree[] {
  return worktrees.map((worktree) => {
    const normalized = normalizeWorktreePath(worktree.path);
    const linked = threadRefs.filter(
      (ref) => normalizeWorktreePath(ref.worktreePath) === normalized,
    );
    const classification: WorktreeClassification = linked.some((ref) => !ref.isArchived)
      ? "active"
      : linked.length > 0
        ? "archived-only"
        : "orphaned";
    return { worktree, classification };
  });
}

export function selectWorktreesForScope(
  classified: readonly ClassifiedWorktree[],
  scope: WorktreeCleanupScope,
): ClassifiedWorktree[] {
  return classified.filter(
    (entry) =>
      entry.classification === "orphaned" ||
      (scope === "orphaned-archived" && entry.classification === "archived-only"),
  );
}
