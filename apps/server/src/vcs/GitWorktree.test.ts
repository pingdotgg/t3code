import { describe, expect, it } from "vite-plus/test";

import { parseGitWorktreeBranchPaths, parseGitWorktreeListPorcelain } from "./GitWorktree.ts";

describe("Git worktree porcelain parsing", () => {
  it("parses newline porcelain and filters detached or prunable branch paths", () => {
    const stdout = [
      "worktree /repo/main",
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/feature",
      "HEAD 2222222",
      "branch refs/heads/feature/demo",
      "",
      "worktree /repo/detached",
      "HEAD 3333333",
      "detached",
      "",
      "worktree /repo/stale",
      "HEAD 4444444",
      "branch refs/heads/stale",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    expect(parseGitWorktreeListPorcelain(stdout)).toEqual([
      { path: "/repo/main", refName: "main", prunable: false },
      { path: "/repo/feature", refName: "feature/demo", prunable: false },
      { path: "/repo/detached", refName: null, prunable: false },
      { path: "/repo/stale", refName: "stale", prunable: true },
    ]);
    expect(parseGitWorktreeBranchPaths(stdout)).toEqual(
      new Map([
        ["main", "/repo/main"],
        ["feature/demo", "/repo/feature"],
      ]),
    );
  });
});
