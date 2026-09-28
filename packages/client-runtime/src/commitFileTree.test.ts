import { describe, expect, it } from "vite-plus/test";
import { buildCommitFileTree, flattenCommitFileTree, toggleCommitFiles } from "./commitFileTree";

const file = (path: string) => ({ path, insertions: 2, deletions: 1 });

describe("commit file grouping", () => {
  it("compacts directory chains, sorts folders first, and keeps duplicate basenames distinct", () => {
    const files = [
      file("README.md"),
      file("src/b/index.ts"),
      file("src/a/index.ts"),
      file("src/main.ts"),
    ];
    const rows = flattenCommitFileTree(buildCommitFileTree(files), new Set());
    expect(rows.map(({ node, depth }) => [node.kind, node.path, depth])).toEqual([
      ["directory", "src", 0],
      ["directory", "src/a", 1],
      ["file", "src/a/index.ts", 2],
      ["directory", "src/b", 1],
      ["file", "src/b/index.ts", 2],
      ["file", "src/main.ts", 1],
      ["file", "README.md", 0],
    ]);
    expect(buildCommitFileTree([file("apps/web/src/main.ts")])[0]).toMatchObject({
      name: "apps/web/src",
      path: "apps/web/src",
      files: [file("apps/web/src/main.ts")],
    });
  });

  it("collapses descendants without dropping them from folder selection", () => {
    const files = [file("src/a/index.ts"), file("src/b/index.ts"), file("README.md")];
    const tree = buildCommitFileTree(files);
    const rows = flattenCommitFileTree(tree, new Set(["src"]));
    expect(rows.map(({ node }) => node.path)).toEqual(["src", "README.md"]);
    const directory = rows[0]!.node;
    if (directory.kind !== "directory") throw new Error("Expected directory");
    const excluded = toggleCommitFiles(directory.files, new Set(["README.md"]));
    expect([...excluded].sort()).toEqual(files.map((file) => file.path).sort());
    expect([...toggleCommitFiles(directory.files, excluded)]).toEqual(["README.md"]);
    expect(flattenCommitFileTree(tree, new Set())).toHaveLength(6);
  });

  it("selects all descendants of a partially selected folder without changing other folders", () => {
    const files = [file("src/a.ts"), file("src/b.ts")];
    const excluded = new Set(["src/a.ts", "other/c.ts"]);
    expect([...toggleCommitFiles(files, excluded)]).toEqual(["other/c.ts"]);
    expect([...excluded]).toEqual(["src/a.ts", "other/c.ts"]);
  });

  it("preserves exact Git paths, untracked directory entries, and file/directory replacements", () => {
    const files = [
      file(".idea/"),
      file("local/a b/main.ts"),
      file("literal\\name.ts"),
      file("old"),
      file("old/new.ts"),
    ];
    const rows = flattenCommitFileTree(buildCommitFileTree(files), new Set());
    const leaves = rows.flatMap(({ node }) => (node.kind === "file" ? [node.file] : []));
    expect(leaves).toHaveLength(files.length);
    expect(new Set(leaves.map((entry) => entry.path))).toEqual(
      new Set(files.map((entry) => entry.path)),
    );
    expect(rows.find(({ node }) => node.path === ".idea/")?.node.name).toBe(".idea/");
    expect(rows.filter(({ node }) => node.path === "old")).toHaveLength(2);
    expect(buildCommitFileTree([])).toEqual([]);
  });
});
