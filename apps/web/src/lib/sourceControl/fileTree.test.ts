import { describe, expect, it } from "vite-plus/test";
import {
  buildSourceControlTree,
  collectAllFolderPaths,
  collectFolderFilePaths,
  flattenSourceControlTree,
  type SourceControlTreeFolderNode,
  type SourceControlTreeNode,
} from "./fileTree";
import type { WorkingCopyFile } from "./types";

// Characterization suite: pins the changes-list tree builder (grouping, VS
// Code-style single-child chain compaction, sorting, flatten order).

function file(path: string, over: Partial<WorkingCopyFile> = {}): WorkingCopyFile {
  return { path, change: "modified", area: "unstaged", ...over };
}

/** Narrowing helper — fails loudly instead of silently skipping assertions. */
function folder(node: SourceControlTreeNode | undefined): SourceControlTreeFolderNode {
  expect(node?.type).toBe("folder");
  return node as SourceControlTreeFolderNode;
}

/** `{folder,path,children}` / `{file}` for compact shape assertions. */
function shape(nodes: ReadonlyArray<SourceControlTreeNode>): unknown[] {
  return nodes.map((node) =>
    node.type === "folder"
      ? { folder: node.name, path: node.path, children: shape(node.children) }
      : { file: node.name },
  );
}

describe("buildSourceControlTree — flat files", () => {
  it("returns file nodes only when every path is at the root", () => {
    const tree = buildSourceControlTree([file("README.md"), file("package.json")]);

    expect(tree).toHaveLength(2);
    expect(tree.every((node) => node.type === "file")).toBe(true);
    // Case-insensitive sort: "package.json" comes before "README.md".
    expect(shape(tree)).toEqual([{ file: "package.json" }, { file: "README.md" }]);
  });

  it("carries the original change through on file nodes, by reference", () => {
    const added = file("new.ts", { change: "added", area: "staged", insertions: 12 });
    const tree = buildSourceControlTree([added]);

    expect(tree[0]).toEqual({ type: "file", name: "new.ts", file: added });
    expect((tree[0] as { file: WorkingCopyFile }).file).toBe(added);
  });

  it("returns an empty array for empty input", () => {
    expect(buildSourceControlTree([])).toEqual([]);
  });
});

describe("buildSourceControlTree — folder hierarchy", () => {
  it("builds nested folders from nested paths", () => {
    const tree = buildSourceControlTree([
      file("src/a.ts"),
      file("src/nested/b.ts"),
      file("src/nested/c.ts"),
    ]);

    expect(shape(tree)).toEqual([
      {
        folder: "src",
        path: "src",
        children: [
          { folder: "nested", path: "src/nested", children: [{ file: "b.ts" }, { file: "c.ts" }] },
          { file: "a.ts" },
        ],
      },
    ]);
  });

  it("reuses an existing folder node for sibling files", () => {
    const tree = buildSourceControlTree([file("src/a.ts"), file("src/b.ts")]);

    expect(tree).toHaveLength(1);
    expect(folder(tree[0]).children).toHaveLength(2);
  });

  it("mixes a root-level file with deeply nested files", () => {
    const tree = buildSourceControlTree([
      file("LICENSE"),
      file("apps/web/src/main/index.ts"),
      file("apps/web/src/main/app.ts"),
    ]);

    expect(shape(tree)).toEqual([
      {
        // `apps` + `web` + `src` + `main` collapse into one row.
        folder: "apps/web/src/main",
        path: "apps/web/src/main",
        children: [{ file: "app.ts" }, { file: "index.ts" }],
      },
      { file: "LICENSE" },
    ]);
  });
});

describe("buildSourceControlTree — single-child folder-chain compaction", () => {
  it("compacts a lone deep path into one row, name = chain, path = deepest folder", () => {
    const tree = buildSourceControlTree([file("src/components/git/Foo.tsx")]);

    expect(tree).toHaveLength(1);
    const node = folder(tree[0]);
    expect(node.name).toBe("src/components/git");
    // `path` is the DEEPEST folder path, not the outermost folder the row
    // started as. Load-bearing for collapse state.
    expect(node.path).toBe("src/components/git");
    expect(shape(node.children)).toEqual([{ file: "Foo.tsx" }]);
  });

  it("keeps name RELATIVE to the parent while path stays ABSOLUTE", () => {
    // `a` cannot compact (it has a folder AND a file), but `b` swallows `c`.
    const tree = buildSourceControlTree([file("a/b/c/d.txt"), file("a/x.txt")]);

    const a = folder(tree[0]);
    expect(a.name).toBe("a");
    expect(a.path).toBe("a");

    const bc = folder(a.children[0]);
    expect(bc.name).toBe("b/c");
    expect(bc.path).toBe("a/b/c");
    expect(shape(bc.children)).toEqual([{ file: "d.txt" }]);
  });

  it("does NOT compact a folder holding a sub-folder and a file", () => {
    const tree = buildSourceControlTree([file("src/lib/util.ts"), file("src/index.ts")]);

    const src = folder(tree[0]);
    expect(src.name).toBe("src");
    expect(shape(src.children)).toEqual([
      { folder: "lib", path: "src/lib", children: [{ file: "util.ts" }] },
      { file: "index.ts" },
    ]);
  });

  it("does NOT compact a folder holding two sub-folders", () => {
    const tree = buildSourceControlTree([file("pkg/one/a.ts"), file("pkg/two/b.ts")]);

    expect(shape(tree)).toEqual([
      {
        folder: "pkg",
        path: "pkg",
        children: [
          { folder: "one", path: "pkg/one", children: [{ file: "a.ts" }] },
          { folder: "two", path: "pkg/two", children: [{ file: "b.ts" }] },
        ],
      },
    ]);
  });

  it("does not compact a leaf folder holding two files, but compacts the chain above it", () => {
    const tree = buildSourceControlTree([file("src/x/a.ts"), file("src/x/b.ts")]);

    expect(shape(tree)).toEqual([
      { folder: "src/x", path: "src/x", children: [{ file: "a.ts" }, { file: "b.ts" }] },
    ]);
  });

  it("compacts several independent chains side by side", () => {
    const tree = buildSourceControlTree([file("one/deep/a.ts"), file("two/deeper/still/b.ts")]);

    expect(shape(tree)).toEqual([
      { folder: "one/deep", path: "one/deep", children: [{ file: "a.ts" }] },
      { folder: "two/deeper/still", path: "two/deeper/still", children: [{ file: "b.ts" }] },
    ]);
  });
});

describe("buildSourceControlTree — sorting", () => {
  it("puts folders before files regardless of input order", () => {
    const tree = buildSourceControlTree([file("zzz.txt"), file("aaa/inner.ts")]);

    expect(tree[0]!.type).toBe("folder");
    expect(tree[1]!.type).toBe("file");
  });

  it("sorts alphabetically within folders and within files", () => {
    const tree = buildSourceControlTree([
      file("c.txt"),
      file("a.txt"),
      file("b.txt"),
      file("zoo/x.ts"),
      file("bar/y.ts"),
    ]);

    expect(shape(tree)).toEqual([
      { folder: "bar", path: "bar", children: [{ file: "y.ts" }] },
      { folder: "zoo", path: "zoo", children: [{ file: "x.ts" }] },
      { file: "a.txt" },
      { file: "b.txt" },
      { file: "c.txt" },
    ]);
  });

  it("sorts case-insensitively", () => {
    const tree = buildSourceControlTree([file("Zebra.txt"), file("apple.txt"), file("Beta.txt")]);

    expect(tree.map((node) => node.name)).toEqual(["apple.txt", "Beta.txt", "Zebra.txt"]);
  });

  it("treats case-only differences as equal and keeps insertion order for them", () => {
    // Sensitivity "base" makes these compare equal, so sort stability decides.
    const tree = buildSourceControlTree([file("readme.md"), file("README.md")]);

    expect(tree.map((node) => node.name)).toEqual(["readme.md", "README.md"]);
  });

  it("sorts recursively at every depth", () => {
    const tree = buildSourceControlTree([
      file("top/z/deep/2.ts"),
      file("top/z/deep/1.ts"),
      file("top/z/file.ts"),
      file("top/a/other.ts"),
      file("top/root.ts"),
    ]);

    expect(shape(tree)).toEqual([
      {
        folder: "top",
        path: "top",
        children: [
          { folder: "a", path: "top/a", children: [{ file: "other.ts" }] },
          {
            folder: "z",
            path: "top/z",
            children: [
              {
                folder: "deep",
                path: "top/z/deep",
                children: [{ file: "1.ts" }, { file: "2.ts" }],
              },
              { file: "file.ts" },
            ],
          },
          { file: "root.ts" },
        ],
      },
    ]);
  });
});

describe("collectFolderFilePaths", () => {
  it("returns every descendant file path in tree order", () => {
    const tree = buildSourceControlTree([
      file("src/z.ts"),
      file("src/a.ts"),
      file("src/nested/deep/b.ts"),
      file("src/nested/c.ts"),
    ]);

    expect(collectFolderFilePaths(folder(tree[0]))).toEqual([
      "src/nested/deep/b.ts",
      "src/nested/c.ts",
      "src/a.ts",
      "src/z.ts",
    ]);
  });

  it("returns the full original path, not the leaf name", () => {
    const tree = buildSourceControlTree([file("a/b/c/deep.ts")]);

    expect(collectFolderFilePaths(folder(tree[0]))).toEqual(["a/b/c/deep.ts"]);
  });

  it("returns an empty array for a folder with no children", () => {
    expect(collectFolderFilePaths({ type: "folder", name: "x", path: "x", children: [] })).toEqual(
      [],
    );
  });
});

describe("collectAllFolderPaths", () => {
  it("returns folder paths depth-first, skipping files", () => {
    const tree = buildSourceControlTree([
      file("src/lib/util.ts"),
      file("src/index.ts"),
      file("docs/readme.md"),
      file("root.txt"),
    ]);

    expect(collectAllFolderPaths(tree)).toEqual(["docs", "src", "src/lib"]);
  });

  it("returns POST-compaction paths — merged intermediate folders are gone", () => {
    const tree = buildSourceControlTree([file("src/components/git/Foo.tsx")]);

    expect(collectAllFolderPaths(tree)).toEqual(["src/components/git"]);
  });

  it("returns an empty array for an empty tree and for file-only trees", () => {
    expect(collectAllFolderPaths([])).toEqual([]);
    expect(collectAllFolderPaths(buildSourceControlTree([file("a.txt"), file("b.txt")]))).toEqual(
      [],
    );
  });
});

describe("flattenSourceControlTree", () => {
  const tree = buildSourceControlTree([
    file("src/lib/util.ts"),
    file("src/index.ts"),
    file("root.txt"),
  ]);

  it("emits depth-first rows with folder depth ascending", () => {
    const rows = flattenSourceControlTree(tree, () => false);
    expect(rows.map((row) => [row.type, row.path, row.depth])).toEqual([
      ["folder", "src", 0],
      ["folder", "src/lib", 1],
      ["file", "src/lib/util.ts", 2],
      ["file", "src/index.ts", 1],
      ["file", "root.txt", 0],
    ]);
  });

  it("hides the whole subtree of a collapsed folder but keeps the folder row", () => {
    const rows = flattenSourceControlTree(tree, (path) => path === "src");
    expect(rows.map((row) => row.path)).toEqual(["src", "root.txt"]);
    expect(rows[0]!.collapsed).toBe(true);
  });

  it("puts every descendant file on the folder row even while collapsed", () => {
    const rows = flattenSourceControlTree(tree, (path) => path === "src");
    expect(rows[0]!.files).toEqual(["src/lib/util.ts", "src/index.ts"]);
  });

  it("does not blow the stack on a pathologically deep path", () => {
    const deep = buildSourceControlTree([
      file(`${Array.from({ length: 5000 }, (_, i) => `d${i}`).join("/")}/leaf.ts`),
    ]);
    const rows = flattenSourceControlTree(deep, () => false);
    // The whole chain compacts to one folder row plus the leaf.
    expect(rows.map((row) => row.type)).toEqual(["folder", "file"]);
  });
});
