import type { VcsPanelSnapshotResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  actionableLocalBranches,
  applyWorkingTreeEnrichments,
  branchOwnsOperationCwd,
  discardableFiles,
  discardPathGroups,
  localBranchForRemoteBranch,
  operationPaths,
  panelChangeSets,
  reconcileSelectedPaths,
  selectedFileStats,
  stashIdentityKey,
  workingTreeEnrichmentRequests,
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

  it("keeps stash identity stable when positional refs are renumbered", () => {
    expect(stashIdentityKey({ refName: "stash@{2}", sha: "abc123" })).toBe("sha:abc123");
    expect(stashIdentityKey({ refName: "stash@{0}", sha: "abc123" })).toBe("sha:abc123");
    expect(stashIdentityKey({ refName: "stash@{0}", sha: null })).toBe("ref:stash@{0}");
  });

  it("matches remote rows only to locals tracking that exact remote ref", () => {
    const current = snapshot();
    const localBranches = [
      {
        name: "release",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: "upstream/release",
      },
      {
        name: "release",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: "origin/release",
      },
      {
        name: "untracked",
        current: false,
        isDefault: false,
        worktreePath: null,
        upstreamName: null,
      },
    ];
    const remoteBranch = {
      name: "release",
      fullRefName: "origin/release",
      isDefaultRemoteHead: false,
    };

    expect(
      localBranchForRemoteBranch({ ...current, localBranches }, { name: "origin" }, remoteBranch),
    ).toBe(localBranches[1]);
    expect(
      localBranchForRemoteBranch(
        { ...current, localBranches: [localBranches[0]!] },
        { name: "origin" },
        remoteBranch,
      ),
    ).toBeNull();
  });

  it("includes both rename sides once in operation paths", () => {
    expect(
      operationPaths([
        { path: "new.ts", originalPath: "old.ts" },
        { path: "new.ts", originalPath: "old.ts" },
      ]),
    ).toEqual(["new.ts", "old.ts"]);
  });

  it("partitions mixed staged and unstaged files for complete discards", () => {
    const files = panelChangeSets(snapshot(), "/repo")[0]?.files ?? [];
    expect(discardPathGroups(files)).toEqual({
      staged: ["src/a.ts"],
      unstaged: ["src/a.ts"],
    });
  });

  it("does not treat conflict-only files as unstaged discard targets", () => {
    const conflictOnlyFile = {
      path: "src/conflict.ts",
      originalPath: null,
      status: "conflicted" as const,
      insertions: 0,
      deletions: 0,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasConflicts: true,
    };
    expect(discardPathGroups([conflictOnlyFile])).toEqual({ staged: [], unstaged: [] });
    expect(discardableFiles([conflictOnlyFile])).toEqual([]);
  });

  it("keeps only files with discardable staged or unstaged changes", () => {
    const files = panelChangeSets(snapshot(), "/repo")[0]?.files ?? [];
    expect(discardableFiles(files)).toEqual(files);
  });

  it("selects new files and drops selection state for clean change sets", () => {
    const [changeSet] = panelChangeSets(snapshot(), "/repo");
    if (!changeSet) throw new Error("Expected a current working-tree fixture");
    const next = reconcileSelectedPaths({
      changeSets: [
        {
          ...changeSet,
          files: [
            ...changeSet.files,
            {
              path: "src/new.ts",
              originalPath: null,
              status: "untracked",
              insertions: 1,
              deletions: 0,
              hasStagedChanges: false,
              hasUnstagedChanges: true,
              hasConflicts: false,
            },
          ],
        },
      ],
      previousKnownPaths: new Map([
        ["/repo", new Set(["src/a.ts"])],
        ["/clean", new Set(["src/done.ts"])],
      ]),
      selectedByCwd: new Map([
        ["/repo", new Set(["src/a.ts"])],
        ["/clean", new Set(["src/done.ts"])],
      ]),
    });

    expect([...next.entries()].map(([cwd, paths]) => [cwd, [...paths]])).toEqual([
      ["/repo", ["src/a.ts", "src/new.ts"]],
    ]);
  });

  it("applies cwd-scoped untracked file enrichment", () => {
    const next: VcsPanelSnapshotResult = {
      ...snapshot(),
      changeGroups: [
        {
          kind: "unstaged",
          files: [
            {
              path: "src/new.ts",
              originalPath: null,
              status: "untracked",
              insertions: 0,
              deletions: 0,
            },
          ],
        },
      ],
    };

    expect(workingTreeEnrichmentRequests(next, "/repo")).toEqual([
      { cwd: "/repo", paths: ["src/new.ts"] },
    ]);
    const enriched = applyWorkingTreeEnrichments(
      next,
      "/repo",
      new Map([
        [
          "/repo",
          {
            files: [
              {
                path: "src/new.ts",
                originalPath: null,
                status: "untracked",
                insertions: 12,
                deletions: 0,
              },
            ],
            hiddenPaths: [],
          },
        ],
      ]),
    );
    expect(panelChangeSets(enriched, "/repo")[0]?.files[0]?.insertions).toBe(12);
  });

  it("only offers merge sync when the target cwd owns the branch", () => {
    const [current, localOnly] = snapshot().localBranches;
    if (!current || !localOnly) throw new Error("Expected current and local-only branch fixtures");
    expect(branchOwnsOperationCwd(current)).toBe(true);
    expect(branchOwnsOperationCwd(localOnly)).toBe(false);
    expect(branchOwnsOperationCwd({ ...localOnly, worktreePath: "/repo-worktree" })).toBe(true);
  });
});
