import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  threadKeepsWorktreeActive,
  type EnvironmentId,
  type ProjectId,
  type WorktreeStorageEntry,
} from "@t3tools/contracts";

import type { WorktreeStoragePreviewEntry } from "../../lib/worktreeStorageState";

export interface ScopedWorktreeStorageEntry extends WorktreeStorageEntry {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface WorktreeProjectGroup {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly faviconPath: string | null;
  readonly worktrees: ReadonlyArray<ScopedWorktreeStorageEntry>;
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

export function worktreeStorageActivityRevision(
  threads: ReadonlyArray<WorktreeStorageLifecycleThread>,
  environmentIds: ReadonlyArray<EnvironmentId>,
): string {
  const includedEnvironments = new Set(environmentIds);
  const activeKeys = new Set<string>();

  for (const thread of threads) {
    if (
      thread.worktreePath === null ||
      !includedEnvironments.has(thread.environmentId) ||
      !threadKeepsWorktreeActive(thread)
    ) {
      continue;
    }
    activeKeys.add(JSON.stringify([thread.environmentId, thread.worktreePath]));
  }

  return JSON.stringify([...activeKeys].sort());
}

export function worktreeStorageProjectGroups(
  previews: ReadonlyArray<WorktreeStoragePreviewEntry>,
): ReadonlyArray<WorktreeProjectGroup> {
  return previews.flatMap(({ environmentId, preview }) =>
    preview.projects.map((project) => ({
      key: JSON.stringify([environmentId, project.projectId]),
      environmentId,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      faviconPath: project.faviconPath,
      worktrees: project.worktrees.map((worktree) => ({
        ...worktree,
        environmentId,
        projectId: project.projectId,
      })),
    })),
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
