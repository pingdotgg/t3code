import { describe, expect, it } from "@effect/vitest";
import type { VcsPanelSnapshotResult, VcsRef } from "@t3tools/contracts";

import {
  beginPanelFileDiffLoad,
  branchAttention,
  branchHasUpstream,
  branchOperationCwd,
  branchSyncState,
  completePanelFileDiffLoad,
  failPanelFileDiffLoad,
  formatRelativeDate,
  mergeChangeGroups,
  stashIdentityKey,
  vcsPanelSnapshotFingerprint,
} from "./SourceControlPanel.logic";

const baseSnapshot: VcsPanelSnapshotResult = {
  status: {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "split/vscode-extension-work",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 7,
    behindCount: 47,
    aheadOfDefaultCount: 0,
    pr: null,
  },
  changeGroups: [],
  worktreeChangeSets: [],
  localBranches: [],
  branchDetails: [],
  remotes: [
    {
      name: "origin",
      fetchUrl: "git@example.test:fork/repo.git",
      pushUrl: "git@example.test:fork/repo.git",
      provider: null,
      branches: [],
    },
    {
      name: "upstream",
      fetchUrl: "git@example.test:upstream/repo.git",
      pushUrl: "git@example.test:upstream/repo.git",
      provider: null,
      branches: [{ name: "main", fullRefName: "upstream/main", isDefaultRemoteHead: true }],
    },
  ],
  actionableForkBranches: [],
  stashes: [],
  recentCommits: [],
  defaultCompareRef: "upstream/main",
};

function branch(input: Partial<VcsRef>): VcsRef {
  return {
    name: "split/vscode-extension-work",
    current: false,
    isDefault: false,
    worktreePath: null,
    ...input,
  };
}

describe("SourceControlPanel branch sync logic", () => {
  it("publishes a local branch whose configured upstream is only its comparison base", () => {
    const localBranch = branch({
      current: true,
      upstreamName: "upstream/main",
      aheadCount: 7,
      behindCount: 47,
    });

    expect(branchHasUpstream(localBranch, baseSnapshot)).toBe(false);
    expect(branchSyncState(localBranch, baseSnapshot)).toBe("publish");
    expect(branchAttention(localBranch, baseSnapshot)).toBe("unpushed");
  });

  it("treats a same-name remote tracking branch as the sync upstream", () => {
    const localBranch = branch({
      name: "split/subagent-threading-work",
      upstreamName: "origin/split/subagent-threading-work",
      aheadCount: 0,
      behindCount: 3,
    });

    expect(branchHasUpstream(localBranch, baseSnapshot)).toBe(true);
    expect(branchSyncState(localBranch, baseSnapshot)).toBe("pull");
    expect(branchAttention(localBranch, baseSnapshot)).toBe("behind");
  });

  it("targets the branch worktree cwd for branch operations when present", () => {
    expect(
      branchOperationCwd(
        branch({
          worktreePath: "/repo.worktrees/feature",
        }),
        "/repo",
      ),
    ).toBe("/repo.worktrees/feature");
    expect(branchOperationCwd(branch({}), "/repo")).toBe("/repo");
  });
});

describe("SourceControlPanel working-tree presentation logic", () => {
  it("sums staged and unstaged stats for the same path", () => {
    expect(
      mergeChangeGroups([
        {
          kind: "staged",
          files: [
            {
              path: "src/file.ts",
              originalPath: null,
              status: "modified",
              insertions: 2,
              deletions: 1,
            },
          ],
        },
        {
          kind: "unstaged",
          files: [
            {
              path: "src/file.ts",
              originalPath: null,
              status: "modified",
              insertions: 3,
              deletions: 4,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        path: "src/file.ts",
        originalPath: null,
        status: "modified",
        insertions: 5,
        deletions: 5,
        hasStagedChanges: true,
        hasUnstagedChanges: true,
        hasConflicts: false,
      },
    ]);
  });

  it("preserves status precedence and conflict flags when merging paths", () => {
    expect(
      mergeChangeGroups([
        {
          kind: "staged",
          files: [
            {
              path: "src/cafe.ts",
              originalPath: null,
              status: "modified",
              insertions: 1,
              deletions: 0,
            },
          ],
        },
        {
          kind: "conflicts",
          files: [
            {
              path: "src/cafe.ts",
              originalPath: null,
              status: "conflicted",
              insertions: 0,
              deletions: 2,
            },
            {
              path: "src/áudio.ts",
              originalPath: null,
              status: "added",
              insertions: 3,
              deletions: 0,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        path: "src/áudio.ts",
        originalPath: null,
        status: "added",
        insertions: 3,
        deletions: 0,
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        hasConflicts: true,
      },
      {
        path: "src/cafe.ts",
        originalPath: null,
        status: "conflicted",
        insertions: 1,
        deletions: 2,
        hasStagedChanges: true,
        hasUnstagedChanges: false,
        hasConflicts: true,
      },
    ]);
  });

  it("formats future timestamps as just now", () => {
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const then = new Date(now + 5 * 60 * 1000).toISOString();

    expect(formatRelativeDate(then, now)).toBe("just now");
  });

  it("formats late-month dates before the one-year threshold as months", () => {
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const then = new Date(now - 360 * 24 * 60 * 60 * 1000).toISOString();

    expect(formatRelativeDate(then, now)).toBe("11 months ago");
  });
});

describe("SourceControlPanel stash identity", () => {
  it("uses the stash commit hash instead of the positional ref when available", () => {
    expect(
      stashIdentityKey({
        refName: "stash@{0}",
        sha: "abc123",
        createdAt: "2026-06-30T13:00:00Z",
        message: "WIP on main: abc123 change",
      }),
    ).toBe("sha:abc123");
  });

  it("falls back to the positional ref for stashes without a hash", () => {
    expect(
      stashIdentityKey({
        refName: "stash@{0}",
        sha: null,
        createdAt: null,
        message: "stash@{0}",
      }),
    ).toBe("ref:stash@{0}");
  });
});

describe("SourceControlPanel refresh stability logic", () => {
  it("fingerprints snapshots with their cwd so equal snapshots from different repos are distinct", () => {
    expect(vcsPanelSnapshotFingerprint("/repo/one", baseSnapshot)).toBe(
      vcsPanelSnapshotFingerprint("/repo/one", { ...baseSnapshot }),
    );
    expect(vcsPanelSnapshotFingerprint("/repo/one", baseSnapshot)).not.toBe(
      vcsPanelSnapshotFingerprint("/repo/two", baseSnapshot),
    );
  });

  it("keeps a loaded diff mounted while a refresh revalidates it", () => {
    const loaded = { status: "loaded", patch: "same patch" } as const;

    expect(beginPanelFileDiffLoad(loaded, { preserveLoaded: true })).toBe(loaded);
    expect(completePanelFileDiffLoad(loaded, "same patch")).toBe(loaded);
    expect(failPanelFileDiffLoad(loaded, "failed", { preserveLoaded: true })).toBe(loaded);
  });

  it("updates preserved loaded diffs only when the refreshed patch changes", () => {
    const loaded = { status: "loaded", patch: "old patch" } as const;

    expect(completePanelFileDiffLoad(loaded, "new patch")).toEqual({
      status: "loaded",
      patch: "new patch",
    });
    expect(beginPanelFileDiffLoad(loaded)).toEqual({ status: "loading" });
    expect(failPanelFileDiffLoad(loaded, "failed")).toEqual({
      status: "error",
      message: "failed",
    });
  });
});
