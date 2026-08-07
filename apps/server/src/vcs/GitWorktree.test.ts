import { describe, expect, it } from "vite-plus/test";

import { parseGitWorktreeBranchPaths, parseGitWorktreeListPorcelain } from "./GitWorktree.ts";

describe("Git worktree porcelain parsing", () => {
  it("keeps detached and prunable entries while preserving branch metadata", () => {
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
    ].join("\0");

    expect(parseGitWorktreeListPorcelain(stdout)).toEqual([
      { path: "/repo/main", refName: "main", prunable: false },
      { path: "/repo/feature", refName: "feature/demo", prunable: false },
      { path: "/repo/detached", refName: null, prunable: false },
      { path: "/repo/stale", refName: "stale", prunable: true },
    ]);
  });

  it("does not split paths containing newlines", () => {
    const stdout = "worktree /repo/line\nfeed\0HEAD 1111111\0branch refs/heads/line\nfeed\0\0";

    expect(parseGitWorktreeListPorcelain(stdout)).toEqual([
      { path: "/repo/line\nfeed", refName: "line\nfeed", prunable: false },
    ]);
    expect(parseGitWorktreeBranchPaths(stdout)).toEqual(
      new Map([["line\nfeed", "/repo/line\nfeed"]]),
    );
  });
});
