import { EnvironmentId, ProjectId, ThreadId, threadKeepsWorktreeActive } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatStorageByteCount,
  worktreeStorageActivityRevision,
  worktreeStorageDirtyConfirmationKey,
  worktreeStorageProjectGroups,
  worktreeStorageSelectionKey,
} from "./WorktreeStorageSettings.logic";

describe("worktree storage settings", () => {
  it("groups previews without losing environment or project identity", () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("project-1");
    const groups = worktreeStorageProjectGroups([
      {
        environmentId,
        preview: {
          totalSizeBytes: 42,
          projects: [
            {
              projectId,
              title: "T3 Code",
              workspaceRoot: "/repo",
              faviconPath: null,
              worktrees: [
                { path: "/worktrees/feature", refName: "feature", sizeBytes: 42, status: "clean" },
              ],
            },
          ],
        },
      },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        environmentId,
        title: "T3 Code",
        worktrees: [expect.objectContaining({ environmentId, projectId })],
      }),
    ]);
    expect(worktreeStorageSelectionKey(groups[0]!.worktrees[0]!)).toBe(
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
    expect(worktreeStorageActivityRevision([settledThread], [environmentId])).toBe(
      worktreeStorageActivityRevision([], [environmentId]),
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

  it("keeps a worktree active while an archived owning thread still has a live runtime", () => {
    const environmentId = EnvironmentId.make("local");
    const archivedLiveThread = {
      environmentId,
      worktreePath: "/worktrees/archived-live",
      archivedAt: "2026-08-12T00:00:00.000Z",
      settledOverride: null,
      session: {
        threadId: ThreadId.make("thread-archived-live"),
        status: "running" as const,
        providerName: "codex",
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
      latestTurn: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      backgroundLiveness: null,
    };
    const archivedIdleThread = {
      ...archivedLiveThread,
      session: null,
    };

    expect(threadKeepsWorktreeActive(archivedLiveThread)).toBe(true);
    expect(threadKeepsWorktreeActive(archivedIdleThread)).toBe(false);
    expect(worktreeStorageActivityRevision([archivedLiveThread], [environmentId])).not.toBe(
      worktreeStorageActivityRevision([archivedIdleThread], [environmentId]),
    );
  });

  it("changes the dirty confirmation key when a selected worktree becomes dirty", () => {
    const environmentId = EnvironmentId.make("local");
    const clean = {
      environmentId,
      path: "/worktrees/feature",
      status: "clean" as const,
    };
    const dirty = { ...clean, status: "dirty" as const };
    const alreadyDirty = {
      environmentId,
      path: "/worktrees/notes",
      status: "dirty" as const,
    };

    expect(worktreeStorageDirtyConfirmationKey([clean, alreadyDirty])).not.toBe(
      worktreeStorageDirtyConfirmationKey([dirty, alreadyDirty]),
    );
    expect(worktreeStorageDirtyConfirmationKey([dirty, alreadyDirty])).toBe(
      worktreeStorageDirtyConfirmationKey([alreadyDirty, dirty]),
    );
  });
});
