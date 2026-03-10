import { describe, expect, test } from "bun:test";

import {
  parseGitBranchesOutput,
  parseGitStatusPorcelain,
  parseGitWorktreeList,
  parseRepositoryPathsOutput,
} from "./git.status";

describe("parseGitStatusPorcelain", () => {
  test("parses a clean published branch", () => {
    const status = parseGitStatusPorcelain(
      [
        "# branch.oid 57c02d18",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +0 -0",
      ].join("\n"),
    );

    expect(status).toEqual({
      currentBranch: "main",
      ahead: 0,
      behind: 0,
      branchPublished: true,
      fileStatus: [],
    });
  });

  test("parses dirty unpublished worktree state", () => {
    const status = parseGitStatusPorcelain(
      [
        "# branch.oid 57c02d18",
        "# branch.head dp/feature-123",
        "1 .M N... 100644 100644 100644 1234567 1234567 README.md",
        "? new-file.ts",
        "2 R. N... 100644 100644 100644 1234567 1234567 R100 src/new-name.ts\tsrc/old-name.ts",
        "u UU N... 100644 100644 100644 100644 1234567 1234567 1234567 conflict.ts",
      ].join("\n"),
    );

    expect(status.currentBranch).toBe("dp/feature-123");
    expect(status.branchPublished).toBe(false);
    expect(status.fileStatus).toEqual([
      {
        name: "README.md",
        staging: "Unmodified",
        worktree: "Modified",
        extra: "",
      },
      {
        name: "new-file.ts",
        staging: "Untracked",
        worktree: "Untracked",
        extra: "",
      },
      {
        name: "src/new-name.ts",
        staging: "Renamed",
        worktree: "Unmodified",
        extra: "src/old-name.ts",
      },
      {
        name: "conflict.ts",
        staging: "Updated but unmerged",
        worktree: "Updated but unmerged",
        extra: "",
      },
    ]);
  });

  test("normalizes detached head to HEAD", () => {
    const status = parseGitStatusPorcelain(
      ["# branch.oid 57c02d18", "# branch.head (detached)"].join("\n"),
    );

    expect(status).toEqual({
      currentBranch: "HEAD",
      fileStatus: [],
    });
  });
});

describe("parseGitBranchesOutput", () => {
  test("deduplicates and filters symbolic remote head rows", () => {
    const branches = parseGitBranchesOutput(
      [
        "main",
        "feature/demo",
        "origin/HEAD",
        "origin/main",
        "origin/feature/demo",
        "origin/main",
      ].join("\n"),
    );

    expect(branches).toEqual({
      branches: ["main", "feature/demo", "origin/main", "origin/feature/demo"],
    });
  });
});

describe("parseRepositoryPathsOutput", () => {
  test("parses repo and worktree path groups", () => {
    const paths = parseRepositoryPathsOutput(
      ["/workspace/repos/affil", "/workspace/repos/affil", "", "/workspace/repos/other"].join("\n"),
      ["/workspace/worktrees/affil/one", "", "/workspace/worktrees/affil/two"].join("\n"),
    );

    expect(paths).toEqual({
      repos: ["/workspace/repos/affil", "/workspace/repos/other"],
      worktrees: ["/workspace/worktrees/affil/one", "/workspace/worktrees/affil/two"],
    });
  });
});

describe("parseGitWorktreeList", () => {
  test("parses porcelain worktree entries", () => {
    const worktrees = parseGitWorktreeList(
      [
        "worktree /workspace/repos/affil",
        "HEAD 19822ca32b277f9f3c13c5e8f641c6229b4bbcc7",
        "branch refs/heads/dev",
        "",
        "worktree /workspace/worktrees/affil/my-worktree",
        "HEAD 19822ca32b277f9f3c13c5e8f641c6229b4bbcc7",
        "branch refs/heads/dp/my-worktree",
        "locked testing",
        "",
      ].join("\n"),
    );

    expect(worktrees).toEqual([
      {
        path: "/workspace/repos/affil",
        head: "19822ca32b277f9f3c13c5e8f641c6229b4bbcc7",
        branch: "dev",
        bare: false,
        detached: false,
      },
      {
        path: "/workspace/worktrees/affil/my-worktree",
        head: "19822ca32b277f9f3c13c5e8f641c6229b4bbcc7",
        branch: "dp/my-worktree",
        bare: false,
        detached: false,
        locked: "testing",
      },
    ]);
  });
});
