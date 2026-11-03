import { describe, expect, it } from "vite-plus/test";

import { buildTurnDiffTree } from "~/lib/turnDiffTree";
import {
  flattenCommitFileTree,
  resolveCommitFileTreeSelection,
  toggleCommitFileTreeNode,
} from "./CommitFileTree.logic";

const tree = buildTurnDiffTree([
  { path: "src/app/page.tsx", additions: 1, deletions: 0 },
  { path: "src/app/layout.tsx", additions: 2, deletions: 1 },
  { path: "src/lib/util.ts", additions: 3, deletions: 0 },
  { path: "README.md", additions: 1, deletions: 1 },
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
});
