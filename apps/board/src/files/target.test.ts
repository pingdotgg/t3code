import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardRoots, fileTarget, locate } from "./target";

const project = { title: "demo", workspaceRoot: "/work/demo/" };
const roots = boardRoots(project, [
  { key: "T-1", worktreePath: "/work/trees/t-1" },
  { key: "T-2", worktreePath: null },
  { key: "T-3", worktreePath: "/work/trees/t-1/" },
]);

describe("boardRoots", () => {
  it("Given tickets, when the roots are built, then the project comes first and each worktree once", () => {
    expect(roots).toEqual([
      { cwd: "/work/demo", label: "demo" },
      { cwd: "/work/trees/t-1", label: "T-1 worktree" },
    ]);
  });
});

describe("locate", () => {
  it("Given a path in a worktree under the project, when it is located, then the deepest root holds it", () => {
    const nested = [...roots, { cwd: "/work/demo/nested", label: "nested" }];

    expect(locate(nested, "/work/demo/nested/a.md")).toEqual({
      root: { cwd: "/work/demo/nested", label: "nested" },
      path: "a.md",
    });
    expect(locate(nested, "/work/demo/b.md")?.path).toBe("b.md");
  });

  it("Given a path outside every root, when it is located, then it is null", () => {
    expect(locate(roots, "/elsewhere/a.md")).toBeNull();
  });
});

describe("fileTarget", () => {
  const board = {
    environmentId: EnvironmentId.make("env"),
    mediaThreadId: "thread",
    orchestratorThreadId: "thread",
    roots,
  };

  it.each([
    [roots[0]!, ".agentboard/demo/plan.md", true],
    [roots[0]!, "src/index.ts", false],
    [roots[1]!, "src/index.ts", true],
  ])("Given %o and %s, when its target is made, then tellable is %s", (root, path, tellable) => {
    expect(fileTarget(board, root, path)).toMatchObject({ cwd: root.cwd, path, tellable });
  });
});
