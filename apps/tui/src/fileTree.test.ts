import { describe, expect, it } from "bun:test";

import { buildFileTree, collectDirPaths, flattenFileTree } from "./fileTree.ts";

const file = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions });

describe("buildFileTree", () => {
  it("Given files in nested dirs, then it groups them and aggregates diff stats", () => {
    const tree = buildFileTree([
      file("src/app.ts", 5, 2),
      file("src/util/clip.ts", 3, 1),
      file("README.md", 1, 0),
    ]);
    // Directories first (src), then files (README.md), alpha within.
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:src", "file:README.md"]);
    const src = tree[0];
    if (src?.kind !== "dir") throw new Error("expected src dir");
    expect(src.additions).toBe(8);
    expect(src.deletions).toBe(3);
    // src has the compacted "util" dir plus the app.ts file.
    expect(src.children.map((n) => `${n.kind}:${n.name}`)).toEqual(["dir:util", "file:app.ts"]);
  });

  it("Given a single-child directory chain, then it compacts into one segment", () => {
    const tree = buildFileTree([file("a/b/c/deep.ts", 4, 0)]);
    const top = tree[0];
    if (top?.kind !== "dir") throw new Error("expected dir");
    expect(top.name).toBe("a/b/c");
    expect(top.children.map((n) => n.name)).toEqual(["deep.ts"]);
  });
});

describe("flattenFileTree", () => {
  it("Given an expanded tree, then it yields dir and file rows with depth", () => {
    const tree = buildFileTree([file("src/app.ts", 5, 2), file("src/util/clip.ts", 3, 1)]);
    const rows = flattenFileTree(tree, new Set());
    expect(rows.map((r) => `${r.kind}:${r.name}@${r.depth}`)).toEqual([
      "dir:src@0",
      "dir:util@1",
      "file:clip.ts@2",
      "file:app.ts@1",
    ]);
  });

  it("Given a collapsed directory, then its children are hidden", () => {
    const tree = buildFileTree([file("src/app.ts"), file("src/util/clip.ts")]);
    const rows = flattenFileTree(tree, new Set(["src"]));
    expect(rows.map((r) => r.name)).toEqual(["src"]);
    expect(rows[0]?.collapsed).toBe(true);
  });

  it("collectDirPaths lists every directory for an expand/collapse-all toggle", () => {
    const tree = buildFileTree([file("src/util/clip.ts"), file("docs/intro.md")]);
    expect(collectDirPaths(tree).sort()).toEqual(["docs", "src/util"]);
  });
});
