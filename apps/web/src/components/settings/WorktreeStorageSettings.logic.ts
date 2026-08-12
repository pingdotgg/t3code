import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, WorktreeStorageEntry } from "@t3tools/contracts";

import type { WorktreeStoragePreviewEntry } from "../../lib/worktreeStorageState";

export interface ScopedWorktreeStorageEntry extends WorktreeStorageEntry {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly faviconPath: string | null;
}

type WorktreeStorageLifecycleThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "worktreePath"
  | "archivedAt"
  | "settledOverride"
  | "session"
  | "latestTurn"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundLiveness"
>;

export function threadKeepsWorktreeActive(thread: WorktreeStorageLifecycleThread): boolean {
  const hasLiveRuntime =
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.backgroundLiveness != null;

  return hasLiveRuntime || (thread.archivedAt === null && thread.settledOverride !== "settled");
}

export function worktreeStorageActivityRevision(
  threads: ReadonlyArray<WorktreeStorageLifecycleThread>,
  environmentIds: ReadonlyArray<EnvironmentId>,
): string {
  const includedEnvironments = new Set(environmentIds);
  const activeByWorktree = new Map<string, boolean>();

  for (const thread of threads) {
    if (thread.worktreePath === null || !includedEnvironments.has(thread.environmentId)) continue;
    const key = JSON.stringify([thread.environmentId, thread.worktreePath]);
    activeByWorktree.set(
      key,
      (activeByWorktree.get(key) ?? false) || threadKeepsWorktreeActive(thread),
    );
  }

  return JSON.stringify([...activeByWorktree].sort(([left], [right]) => left.localeCompare(right)));
}

export function flattenWorktreeStoragePreviews(
  previews: ReadonlyArray<WorktreeStoragePreviewEntry>,
): ReadonlyArray<ScopedWorktreeStorageEntry> {
  return previews.flatMap(({ environmentId, preview }) =>
    preview.projects.flatMap((project) =>
      project.worktrees.map((worktree) => ({
        ...worktree,
        environmentId,
        projectId: project.projectId,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        faviconPath: project.faviconPath,
      })),
    ),
  );
}

export function worktreeStorageSelectionKey(
  entry: Pick<ScopedWorktreeStorageEntry, "environmentId" | "path">,
): string {
  return JSON.stringify([entry.environmentId, entry.path]);
}

export function formatStorageByteCount(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = sizeBytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const fractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

export function sumWorktreeStorageBytes(
  worktrees: ReadonlyArray<Pick<WorktreeStorageEntry, "sizeBytes">>,
): number {
  return worktrees.reduce((total, worktree) => total + worktree.sizeBytes, 0);
}
