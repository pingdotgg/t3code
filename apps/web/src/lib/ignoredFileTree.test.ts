import { describe, expect, it } from "vite-plus/test";

import { COPYABLE_FILE_MAX_BYTES } from "./addProjectToMachine";
import {
  buildIgnoredFileTree,
  countSelectedIgnoredDescendants,
  getDefaultIgnoredFileExpansion,
  type IgnoredFileTreeNode,
} from "./ignoredFileTree";

const file = (path: string, byteLength = 10) => ({ path, byteLength });

function listedPaths(nodes: readonly IgnoredFileTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "file" ? [node.file.path] : listedPaths(node.children),
  );
}

describe("ignored file tree", () => {
  it("groups crowded directories and keeps files and folders in code-unit name order", () => {
    const files = [
      file("z-folder/file"),
      file("README.md"),
      file(".env"),
      file(".agents/z.md"),
      file(".agents/A.md"),
    ];
    const tree = buildIgnoredFileTree(files);
    expect(tree.map((node) => [node.name, node.kind])).toEqual([
      [".agents", "directory"],
      [".env", "file"],
      ["README.md", "file"],
      ["z-folder", "directory"],
    ]);
    expect(tree[0]).toMatchObject({
      listedCount: 2,
      children: [{ name: "A.md" }, { name: "z.md" }],
    });
    expect(listedPaths(tree)).toEqual(files.map((entry) => entry.path).toSorted());
  });

  it("preserves exact Git paths and literal backslashes", () => {
    const files = [file("literal\\folder/.env.local"), file(".agents/a\\b.md"), file("root\\file")];
    const tree = buildIgnoredFileTree(files);
    expect(listedPaths(tree).toSorted()).toEqual(files.map((entry) => entry.path).toSorted());
    expect(tree.map((node) => node.name)).toEqual([".agents", "literal\\folder", "root\\file"]);
  });

  it("compacts directory chains to the deepest path but never into a file", () => {
    const tree = buildIgnoredFileTree([
      file("services/api/config/.env"),
      file("services/api/config/secret"),
      file("single/only.txt"),
    ]);
    expect(tree).toMatchObject([
      {
        kind: "directory",
        name: "services/api/config",
        path: "services/api/config",
        listedCount: 2,
        children: [{ name: ".env" }, { name: "secret" }],
      },
      {
        kind: "directory",
        name: "single",
        path: "single",
        listedCount: 1,
        children: [{ kind: "file", name: "only.txt" }],
      },
    ]);
    expect(Array.from(getDefaultIgnoredFileExpansion(tree))).toEqual(["services/api/config"]);
  });

  it("opens default environment ancestors and leaves crowded agent files collapsed", () => {
    const tree = buildIgnoredFileTree([
      file(".agents/skills/one.md"),
      file(".agents/skills/two.md"),
      file("apps/api/.env.local"),
      file("apps/web/.dev.vars"),
      file("apps/web/debug.log"),
      file("private/.env", COPYABLE_FILE_MAX_BYTES + 1),
      file(".env"),
    ]);
    expect(Array.from(getDefaultIgnoredFileExpansion(tree)).toSorted()).toEqual([
      "apps",
      "apps/api",
      "apps/web",
    ]);
  });

  it("counts selected descendants even when they are outside the current bounded listing", () => {
    const selected = new Set([
      ".agents/a.md",
      ".agents/unlisted/b.md",
      ".agents-other/c.md",
      ".env",
      "apps/api/.env",
    ]);
    expect(countSelectedIgnoredDescendants(".agents", selected)).toBe(2);
    expect(countSelectedIgnoredDescendants("apps/api", selected)).toBe(1);
    expect(countSelectedIgnoredDescendants("apps/web", selected)).toBe(0);
  });

  it("keeps file metadata for selection and handles an empty list", () => {
    const original = file("config/.env", 512);
    const tree = buildIgnoredFileTree([original]);
    expect(tree).toMatchObject([{ children: [{ file: original }] }]);
    expect(buildIgnoredFileTree([])).toEqual([]);
    expect(getDefaultIgnoredFileExpansion([]).size).toBe(0);
  });
});
