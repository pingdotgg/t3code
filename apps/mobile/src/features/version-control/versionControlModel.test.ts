import type { VcsPanelSnapshotResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  actionableLocalBranches,
  operationPaths,
  panelChangeSets,
  selectedFileStats,
} from "./versionControlModel";

function snapshot(): VcsPanelSnapshotResult {
  return {
    status: {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/mobile-vcs",
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 0,
      pr: null,
    },
    changeGroups: [
      {
        kind: "staged",
        files: [
          {
            path: "src/a.ts",
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
            path: "src/a.ts",
            originalPath: null,
            status: "modified",
            insertions: 3,
            deletions: 4,
          },
        ],
      },
    ],
    worktreeChangeSets: [],
    localBranches: [
      {
        name: "feature/mobile-vcs",
        current: true,
        isDefault: false,
        worktreePath: null,
        upstreamName: "origin/feature/mobile-vcs",
      },
      {
        name: "local-only",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: null,
      },
      {
        name: "synced",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: "origin/synced",
        aheadCount: 0,
        behindCount: 0,
      },
    ],
    branchDetails: [],
    remotes: [{ name: "origin", fetchUrl: null, pushUrl: null, provider: null, branches: [] }],
    actionableForkBranches: [],
    stashes: [],
    recentCommits: [],
    defaultCompareRef: "main",
  };
}

describe("native Version Control model", () => {
  it("merges the current working tree and preserves aggregate selected stats", () => {
    const [changeSet] = panelChangeSets(snapshot(), "/repo");
    expect(changeSet?.files).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        insertions: 5,
        deletions: 5,
        hasStagedChanges: true,
        hasUnstagedChanges: true,
      }),
    ]);
    expect(selectedFileStats(changeSet?.files ?? [])).toEqual({ insertions: 5, deletions: 5 });
  });

  it("shows only branches that need action", () => {
    expect(actionableLocalBranches(snapshot()).map((branch) => branch.name)).toEqual([
      "feature/mobile-vcs",
      "local-only",
    ]);
  });

  it("includes both rename sides once in operation paths", () => {
    expect(
      operationPaths([
        { path: "new.ts", originalPath: "old.ts" },
        { path: "new.ts", originalPath: "old.ts" },
      ]),
    ).toEqual(["new.ts", "old.ts"]);
  });
});
