import { describe, expect, it } from "vite-plus/test";

import { boardRoots, locate } from "./target";

const project = { title: "demo", workspaceRoot: "/work/demo/" };
const roots = boardRoots(project, [
  { key: "T-1", worktreePath: "/work/trees/t-1", base: "origin/main" },
  { key: "T-2", worktreePath: null },
]);

describe("boardRoots", () => {
  it("Given tickets, when the roots are built, then the project comes first and each worktree follows", () => {
    expect(roots).toEqual([
      { cwd: "/work/demo", label: "demo", base: null },
      { cwd: "/work/trees/t-1", label: "T-1 worktree", base: "origin/main" },
    ]);
  });
});

describe("locate", () => {
  it("Given a path in the project, when it is located, then the root holds it and the path is relative to it", () => {
    expect(locate(roots, "/work/demo/b.md")?.path).toBe("b.md");
  });

  it("Given a path outside every root, when it is located, then it is null", () => {
    expect(locate(roots, "/elsewhere/a.md")).toBeNull();
  });
});
