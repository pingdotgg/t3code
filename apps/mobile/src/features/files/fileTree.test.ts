import { describe, expect, it } from "vite-plus/test";
import type { ProjectEntry } from "@t3tools/contracts";

import { buildFileTree, defaultExpandedTreePaths, flattenFileTree } from "./fileTree";

const entries = [
  { kind: "file", path: "README.md" },
  { kind: "directory", path: "src" },
  { kind: "file", path: "src/index.ts" },
  { kind: "file", path: "src/components/App.tsx" },
  { kind: "file", path: "package.json" },
] satisfies ReadonlyArray<ProjectEntry>;

describe("mobile file tree helpers", () => {
  it("builds a deterministic hierarchy with directories before files", () => {
    const tree = buildFileTree(entries);

    expect(tree.map((node) => `${node.kind}:${node.path}`)).toEqual([
      "directory:src",
      "file:package.json",
      "file:README.md",
    ]);
    expect(tree[0]?.children.map((node) => `${node.kind}:${node.path}`)).toEqual([
      "directory:src/components",
      "file:src/index.ts",
    ]);
  });

  it("flattens expanded directories and hides collapsed descendants", () => {
    const tree = buildFileTree(entries);

    expect(
      flattenFileTree({
        nodes: tree,
        expanded: new Set(["src"]),
      }).map((item) => `${item.depth}:${item.node.path}`),
    ).toEqual(["0:src", "1:src/components", "1:src/index.ts", "0:package.json", "0:README.md"]);

    expect(
      flattenFileTree({
        nodes: tree,
        expanded: new Set(),
      }).map((item) => item.node.path),
    ).toEqual(["src", "package.json", "README.md"]);
  });

  it("includes matching descendants and their ancestors during search", () => {
    const tree = buildFileTree(entries);

    expect(
      flattenFileTree({
        nodes: tree,
        expanded: new Set(),
        searchResultPaths: new Set(["src/components/App.tsx"]),
      }).map((item) => item.node.path),
    ).toEqual(["src", "src/components", "src/components/App.tsx"]);
  });

  it("excludes cached children of matched directories", () => {
    expect(
      flattenFileTree({
        nodes: buildFileTree(entries),
        expanded: new Set(["src", "src/components"]),
        searchResultPaths: new Set(["src/components"]),
      }).map((item) => item.node.path),
    ).toEqual(["src", "src/components"]);
  });

  it("keeps an empty search empty and restores expansion when search clears", () => {
    const tree = buildFileTree(entries);
    expect(
      flattenFileTree({ nodes: tree, expanded: new Set(["src"]), searchResultPaths: new Set() }),
    ).toEqual([]);
    expect(
      flattenFileTree({ nodes: tree, expanded: new Set(), searchResultPaths: null }).map(
        (item) => item.node.path,
      ),
    ).toEqual(["src", "package.json", "README.md"]);
  });

  it("expands top-level directories by default", () => {
    const tree = buildFileTree(entries);

    expect([...defaultExpandedTreePaths(tree)]).toEqual(["src"]);
  });
});
