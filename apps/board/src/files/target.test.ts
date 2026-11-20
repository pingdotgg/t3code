import { describe, expect, it } from "vite-plus/test";

import { boardRoots, locate } from "./target";

const project = { title: "demo", workspaceRoot: "/work/demo/" };
const roots = boardRoots(project, [
  { key: "T-1", worktreePath: "/work/trees/t-1", base: "origin/main" },
  { key: "T-2", worktreePath: null },
  { key: "T-3", worktreePath: "/work/trees/t-1/" },
]);

describe("boardRoots", () => {
  it("Given tickets, when the roots are built, then the project comes first and each worktree once", () => {
    expect(roots).toEqual([
      { cwd: "/work/demo", label: "demo", base: null },
      { cwd: "/work/trees/t-1", label: "T-1 worktree", base: "origin/main" },
    ]);
  });
});

describe("locate", () => {
  it("Given a path in a worktree under the project, when it is located, then the deepest root holds it", () => {
    const nested = [...roots, { cwd: "/work/demo/nested", label: "nested", base: null }];

    expect(locate(nested, "/work/demo/nested/a.md")).toEqual({
      root: { cwd: "/work/demo/nested", label: "nested", base: null },
      path: "a.md",
    });
    expect(locate(nested, "/work/demo/b.md")?.path).toBe("b.md");
  });

  it("Given a path outside every root, when it is located, then it is null", () => {
    expect(locate(roots, "/elsewhere/a.md")).toBeNull();
  });
});
