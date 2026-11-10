import { expect, it } from "vite-plus/test";

import { buildFileTree, flattenFileTree } from "./fileTree";

it("flattens a wide expanded directory without exceeding argument limits", () => {
  const children = Array.from({ length: 200_000 }, (_, index) => ({
    path: `root/file-${index}`,
    name: `file-${index}`,
    kind: "file" as const,
    children: [],
  }));
  const nodes = [{ path: "root", name: "root", kind: "directory" as const, children }];
  const rows = flattenFileTree({ nodes, expanded: new Set(["root"]) });
  expect(rows).toHaveLength(children.length + 1);
  expect(rows[0]).toEqual({ node: nodes[0], depth: 0 });
  const middleChildIndex = Math.floor(children.length / 2);
  expect(rows[middleChildIndex + 1]).toEqual({
    node: children[middleChildIndex],
    depth: 1,
  });
  expect(rows.at(-1)).toEqual({ node: children.at(-1), depth: 1 });
});

it("prunes unmatched subtrees without losing adjacent rows or their depths", () => {
  const nodes = buildFileTree([
    { kind: "file", path: "root/a/hidden.txt" },
    { kind: "file", path: "root/b/match.txt" },
    { kind: "file", path: "root/b/other.txt" },
    { kind: "file", path: "root/c/hidden.txt" },
    { kind: "file", path: "tail.txt" },
  ]);
  const expanded = new Set(["root", "root/a", "root/b", "root/c"]);
  const rows = (searchResultPaths: ReadonlySet<string> | null) =>
    flattenFileTree({ nodes, expanded, searchResultPaths }).map(
      ({ node, depth }) => `${depth}:${node.path}`,
    );

  expect(rows(new Set(["root/b/match.txt", "tail.txt"]))).toEqual([
    "0:root",
    "1:root/b",
    "2:root/b/match.txt",
    "0:tail.txt",
  ]);
  expect(rows(new Set(["root/b"]))).toEqual(["0:root", "1:root/b"]);
  expect(rows(new Set())).toEqual([]);
  expect(rows(null)).toEqual([
    "0:root",
    "1:root/a",
    "2:root/a/hidden.txt",
    "1:root/b",
    "2:root/b/match.txt",
    "2:root/b/other.txt",
    "1:root/c",
    "2:root/c/hidden.txt",
    "0:tail.txt",
  ]);
  expect(flattenFileTree({ nodes, expanded: new Set() }).map(({ node }) => node.path)).toEqual([
    "root",
    "tail.txt",
  ]);
});
