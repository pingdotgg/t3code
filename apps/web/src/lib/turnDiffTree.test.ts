import { describe, expect, it } from "vite-plus/test";

import { buildTurnDiffTree } from "./turnDiffTree";

describe("buildTurnDiffTree", () => {
  it("sorts directory and file names numerically with directories first", () => {
    const tree = buildTurnDiffTree([
      { path: "file10.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "dir10/file10.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "file2.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "dir2/file10.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "dir2/file2.ts", kind: "modified", additions: 1, deletions: 0 },
    ]);

    expect(tree.map((node) => node.name)).toEqual(["dir2", "dir10", "file2.ts", "file10.ts"]);
    const directory = tree[0];
    expect(directory?.kind).toBe("directory");
    if (directory?.kind !== "directory") throw new Error("Expected a directory");
    expect(directory.children.map((node) => node.name)).toEqual(["file2.ts", "file10.ts"]);
  });

  it("preserves input order for case- and accent-insensitive name ties", () => {
    const tree = buildTurnDiffTree([
      { path: "a.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "A.ts", kind: "modified", additions: 2, deletions: 0 },
      { path: "FOLDER/a.ts", kind: "modified", additions: 3, deletions: 0 },
      { path: "folder/a.ts", kind: "modified", additions: 4, deletions: 0 },
      { path: "café.ts", kind: "modified", additions: 5, deletions: 0 },
      { path: "Cafe.ts", kind: "modified", additions: 6, deletions: 0 },
      { path: "cafe.ts", kind: "modified", additions: 7, deletions: 0 },
    ]);

    expect(tree.map((node) => node.name)).toEqual([
      "FOLDER",
      "folder",
      "a.ts",
      "A.ts",
      "café.ts",
      "Cafe.ts",
      "cafe.ts",
    ]);
  });

  it("builds nested directory nodes with aggregated stats", () => {
    const tree = buildTurnDiffTree([
      { path: "src/index.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/components/Button.tsx", kind: "modified", additions: 4, deletions: 2 },
      { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "src",
        path: "src",
        stat: { additions: 6, deletions: 3 },
        children: [
          {
            kind: "directory",
            name: "components",
            path: "src/components",
            stat: { additions: 4, deletions: 2 },
            children: [
              {
                kind: "file",
                name: "Button.tsx",
                path: "src/components/Button.tsx",
                stat: { additions: 4, deletions: 2 },
              },
            ],
          },
          {
            kind: "file",
            name: "index.ts",
            path: "src/index.ts",
            stat: { additions: 2, deletions: 1 },
          },
        ],
      },
      {
        kind: "file",
        name: "README.md",
        path: "README.md",
        stat: { additions: 1, deletions: 0 },
      },
    ]);
  });

  it("compacts only single-directory chains and stops at branch points", () => {
    expect(
      buildTurnDiffTree([
        { path: "src/a/b/first.ts", kind: "modified", additions: 1, deletions: 0 },
        { path: "src/c/d/second.ts", kind: "modified", additions: 2, deletions: 0 },
      ]),
    ).toMatchObject([
      {
        name: "src",
        children: [
          { name: "a/b", path: "src/a/b", children: [{ name: "first.ts" }] },
          { name: "c/d", path: "src/c/d", children: [{ name: "second.ts" }] },
        ],
      },
    ]);

    const tree = buildTurnDiffTree([
      { path: "apps/server/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "apps/server/main.ts", kind: "modified", additions: 4, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/server",
        path: "apps/server",
        stat: { additions: 6, deletions: 1 },
        children: [
          {
            kind: "directory",
            name: "src",
            path: "apps/server/src",
            stat: { additions: 2, deletions: 1 },
            children: [
              {
                kind: "file",
                name: "index.ts",
                path: "apps/server/src/index.ts",
                stat: { additions: 2, deletions: 1 },
              },
            ],
          },
          {
            kind: "file",
            name: "main.ts",
            path: "apps/server/main.ts",
            stat: { additions: 4, deletions: 0 },
          },
        ],
      },
    ]);
  });
});
