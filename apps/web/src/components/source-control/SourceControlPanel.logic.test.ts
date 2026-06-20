import { describe, expect, it } from "@effect/vitest";
import type { VcsPanelSnapshotResult, VcsRef } from "@t3tools/contracts";

import { branchAttention, branchHasUpstream, branchSyncState } from "./SourceControlPanel.logic";

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
});
