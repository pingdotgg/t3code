import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  flattenWorktreeStoragePreviews,
  formatStorageByteCount,
  threadKeepsWorktreeActive,
  worktreeStorageActivityRevision,
  worktreeStorageSelectionKey,
} from "./WorktreeStorageSettings.logic";

describe("worktree storage settings", () => {
  it("flattens previews without losing environment or project identity", () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("project-1");
    const entries = flattenWorktreeStoragePreviews([
      {
        environmentId,
        preview: {
          totalSizeBytes: 42,
          reclaimableSizeBytes: 42,
          projects: [
            {
              projectId,
              title: "T3 Code",
              workspaceRoot: "/repo",
              faviconPath: null,
              sizeBytes: 42,
              worktrees: [
                { path: "/worktrees/feature", refName: "feature", sizeBytes: 42, status: "clean" },
              ],
            },
          ],
        },
      },
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ environmentId, projectId, projectTitle: "T3 Code" }),
    ]);
    expect(worktreeStorageSelectionKey(entries[0]!)).toBe(
      JSON.stringify([environmentId, "/worktrees/feature"]),
    );
  });

  it("formats byte counts at readable binary thresholds", () => {
    expect(formatStorageByteCount(0)).toBe("0 B");
    expect(formatStorageByteCount(1_024)).toBe("1.00 KB");
    expect(formatStorageByteCount(10 * 1_024)).toBe("10.0 KB");
    expect(formatStorageByteCount(1_024 * 1_024)).toBe("1.00 MB");
  });

  it("invalidates storage when live worktree ownership settles", () => {
    const environmentId = EnvironmentId.make("local");
    const activeThread = {
      environmentId,
      worktreePath: "/worktrees/feature",
      archivedAt: null,
      settledOverride: null,
      session: null,
      latestTurn: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      backgroundLiveness: null,
    } as const;
    const settledThread = {
      ...activeThread,
      settledOverride: "settled",
    } as const;

    expect(threadKeepsWorktreeActive(activeThread)).toBe(true);
    expect(threadKeepsWorktreeActive(settledThread)).toBe(false);
    expect(worktreeStorageActivityRevision([activeThread], [environmentId])).not.toBe(
      worktreeStorageActivityRevision([settledThread], [environmentId]),
    );
  });

  it("keeps a shared worktree active while any owning thread is active", () => {
    const environmentId = EnvironmentId.make("local");
    const activeThread = {
      environmentId,
      worktreePath: "/worktrees/shared",
      archivedAt: null,
      settledOverride: null,
      session: null,
      latestTurn: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      backgroundLiveness: null,
    } as const;
    const settledThread = { ...activeThread, settledOverride: "settled" } as const;

    expect(worktreeStorageActivityRevision([activeThread], [environmentId])).toBe(
      worktreeStorageActivityRevision([settledThread, activeThread], [environmentId]),
    );
  });
});
