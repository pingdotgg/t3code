import { expect, it } from "vite-plus/test";

import { flattenFileTree } from "./fileTree";

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
