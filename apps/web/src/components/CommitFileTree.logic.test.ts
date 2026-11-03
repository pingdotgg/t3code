import { describe, expect, it } from "vite-plus/test";

import {
  buildCommitFileTree,
  flattenCommitFileTree,
  resolveCommitFileTreeSelection,
  toggleCommitFileTreeNode,
} from "./CommitFileTree.logic";

const tree = buildCommitFileTree([
  { path: "src/app/page.tsx", insertions: 1, deletions: 0 },
  { path: "src/app/layout.tsx", insertions: 2, deletions: 1 },
  { path: "src/lib/util.ts", insertions: 3, deletions: 0 },
  { path: "README.md", insertions: 1, deletions: 1 },
]);
const src = tree[0]!;

describe("commit file tree", () => {
  it("hides the children of collapsed folders", () => {
    const rows = (collapsed: string[]) =>
      flattenCommitFileTree(tree, new Set(collapsed)).map(
        (row) => `${"  ".repeat(row.depth)}${row.node.name}`,
      );

    expect(rows([])).toEqual([
      "src",
      "  app",
      "    layout.tsx",
      "    page.tsx",
      "  lib",
      "    util.ts",
      "README.md",
    ]);
    expect(rows(["src/app"])).toEqual(["src", "  app", "  lib", "    util.ts", "README.md"]);
  });

  it("toggles every file below a folder and reports partial selection", () => {
    expect(resolveCommitFileTreeSelection(src, new Set())).toBe("all");
    expect(resolveCommitFileTreeSelection(src, new Set(["src/lib/util.ts"]))).toBe("some");

    const excluded = toggleCommitFileTreeNode(src, new Set(["README.md"]));
    expect([...excluded].toSorted()).toEqual([
      "README.md",
      "src/app/layout.tsx",
      "src/app/page.tsx",
      "src/lib/util.ts",
    ]);
    expect(resolveCommitFileTreeSelection(src, excluded)).toBe("none");

    const partial = new Set(["src/lib/util.ts", "README.md"]);
    expect([...toggleCommitFileTreeNode(src, partial)]).toEqual(["README.md"]);
  });

  it("keeps a backslash in a Git path as part of the file name", () => {
    const [docs] = buildCommitFileTree([
      { path: "docs/a\\b.md", insertions: 1, deletions: 0 },
      { path: "docs/c.md", insertions: 1, deletions: 0 },
    ]);

    expect(flattenCommitFileTree([docs!], new Set()).map((row) => row.node.path)).toEqual([
      "docs",
      "docs/a\\b.md",
      "docs/c.md",
    ]);
    expect([...toggleCommitFileTreeNode(docs!, new Set())]).toEqual(["docs/a\\b.md", "docs/c.md"]);
  });
});
