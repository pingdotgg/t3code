import { describe, expect, it } from "vite-plus/test";

import { parseGitWorktreeBranchPaths, parseGitWorktreeListPorcelain } from "./GitWorktree.ts";

describe("Git worktree porcelain parsing", () => {
  it("parses NUL-terminated porcelain and filters detached or prunable branch paths", () => {
    const stdout = [
      "worktree /repo/main",
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/line\nbreak",
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
      { path: "/repo/main", refName: "main", headCommit: "1111111", prunable: false },
      {
        path: "/repo/line\nbreak",
        refName: "feature/demo",
        headCommit: "2222222",
        prunable: false,
      },
      { path: "/repo/detached", refName: null, headCommit: "3333333", prunable: false },
      { path: "/repo/stale", refName: "stale", headCommit: "4444444", prunable: true },
    ]);
    expect(parseGitWorktreeBranchPaths(stdout)).toEqual(
      new Map([
        ["main", "/repo/main"],
        ["feature/demo", "/repo/line\nbreak"],
      ]),
    );
  });
});
