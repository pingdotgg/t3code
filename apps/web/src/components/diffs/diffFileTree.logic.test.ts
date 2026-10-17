import type { FileDiffMetadata } from "@pierre/diffs";
import { FileTree, preloadFileTree } from "@pierre/trees";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreeModel,
  diffFileTreePositions,
  diffFileTreeEntries,
} from "./diffFileTree.logic";

function file(type: FileDiffMetadata["type"], name: string, prevName = name): FileDiffMetadata {
  return { type, name, prevName } as FileDiffMetadata;
}

describe("diffFileTreeEntries", () => {
  it("maps each change type to its git status under the file's current path", () => {
    expect(
      diffFileTreeEntries([
        file("new", "a/src/a.ts"),
        file("deleted", "src/b.ts"),
        file("rename-pure", "src/c.ts", "src/old-c.ts"),
        file("rename-changed", "src/d.ts", "src/old-d.ts"),
        file("change", "README.md"),
      ]),
    ).toEqual([
      { path: "a/src/a.ts", status: "added" },
      { path: "src/b.ts", status: "deleted" },
      { path: "src/c.ts", status: "renamed" },
      { path: "src/d.ts", status: "renamed" },
      { path: "README.md", status: "modified" },
    ]);
  });
});

describe("diffFileTreeEntries", () => {
  it("folds a file-to-symlink type change into one modified entry", () => {
    expect(
      diffFileTreeEntries([
        file("change", "CLAUDE.md"),
        file("deleted", "AGENTS.md"),
        file("new", "AGENTS.md"),
        file("new", "docs/new.md"),
      ]),
    ).toEqual([
      { path: "CLAUDE.md", status: "modified" },
      { path: "AGENTS.md", status: "modified" },
      { path: "docs/new.md", status: "added" },
    ]);
  });
});

describe("collectDirectoryPaths", () => {
  it("lists every ancestor once, parents first, with Pierre's trailing slash", () => {
    expect(collectDirectoryPaths(["apps/web/src/a.ts", "apps/web/b.ts", "README.md"])).toEqual([
      "apps/",
      "apps/web/",
      "apps/web/src/",
    ]);
  });
});

describe("diff tree reading order", () => {
  it("places folders and files where their first diff appears", () => {
    const paths = [
      "apps/mobile/src/state/shell.ts",
      "apps/mobile/src/features/threads/route.ts",
      "apps/mobile/src/features/threads/screen.tsx",
    ];
    const positions = diffFileTreePositions(paths);
    const tree = preloadFileTree({
      paths,
      initialExpansion: "open",
      flattenEmptyDirectories: true,
      sort: compareDiffFileTreeEntries(() => positions),
    });
    const rows = [...tree.shadowHtml.matchAll(/data-item-path="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(rows).toEqual([
      "apps/mobile/src/",
      "apps/mobile/src/state/",
      "apps/mobile/src/state/shell.ts",
      "apps/mobile/src/features/threads/",
      "apps/mobile/src/features/threads/route.ts",
      "apps/mobile/src/features/threads/screen.tsx",
    ]);
  });
});

describe("buildDiffFileTreeUpdates", () => {
  it("adds a new file's directories before the file", () => {
    expect(buildDiffFileTreeUpdates(["README.md"], ["README.md", "src/lib/a.ts"])).toEqual([
      { type: "add", path: "src/" },
      { type: "add", path: "src/lib/" },
      { type: "add", path: "src/lib/a.ts" },
    ]);
  });

  it("removes files before their now-empty directories, deepest first", () => {
    expect(buildDiffFileTreeUpdates(["src/lib/a.ts", "src/b.ts"], ["src/b.ts"])).toEqual([
      { type: "remove", path: "src/lib/a.ts" },
      { type: "remove", path: "src/lib/", recursive: true },
    ]);
  });

  it("keeps a directory that still holds a file", () => {
    expect(buildDiffFileTreeUpdates(["src/a.ts", "src/b.ts"], ["src/b.ts"])).toEqual([
      { type: "remove", path: "src/a.ts" },
    ]);
  });

  it("produces nothing when the paths are unchanged", () => {
    expect(buildDiffFileTreeUpdates(["src/a.ts"], ["src/a.ts"])).toEqual([]);
  });
});

describe("diffFileTreeModel", () => {
  it("returns ordinary paths unchanged", () => {
    const paths = ["src/a.ts", "README.md"];
    const presented = diffFileTreeModel(paths);
    expect(presented.paths).toBe(paths);
    expect(presented.selectionPath("src/a.ts")).toBe("src/a.ts");
    expect(presented.modelPath("src/a.ts")).toBe("src/a.ts");
  });

  it("does not treat a shared string prefix as a directory collision", () => {
    const paths = ["office", "officer.ts"];
    expect(diffFileTreeModel(paths).paths).toBe(paths);
  });

  it("does not rewrite a directory that only contains files", () => {
    const paths = ["office/config.ts", "office/index.ts"];
    expect(diffFileTreeModel(paths).paths).toBe(paths);
  });

  it("keeps a file that is also a directory prefix selectable in Pierre", () => {
    const paths = ["office", "office/config.ts"];
    const presented = diffFileTreeModel(paths);
    expect(presented.paths).not.toBe(paths);
    expect(presented.selectionPath(presented.modelPath("office"))).toBe("office");
    expect(presented.selectionPath(presented.modelPath("office/config.ts"))).toBe(
      "office/config.ts",
    );
    expect(presented.modelPath("office/config.ts")).toBe("office/config.ts");
    expect(presented.modelPath("office")).not.toBe("office");

    const tree = new FileTree({
      paths: presented.paths,
      initialExpansion: "open",
      flattenEmptyDirectories: true,
    });
    expect(tree.getItem(presented.modelPath("office"))?.isDirectory()).toBe(false);
    expect(tree.getItem("office/")?.isDirectory()).toBe(true);
    expect(tree.getItem("office/config.ts")?.isDirectory()).toBe(false);
    tree.cleanUp();
  });

  it("keeps the reverse directory-to-file transition selectable", () => {
    const paths = ["office/config.ts", "office"];
    const presented = diffFileTreeModel(paths);
    expect(presented.paths[0]).toBe("office/config.ts");
    expect(presented.selectionPath(presented.modelPath("office"))).toBe("office");
    expect(() => {
      const tree = new FileTree({ paths: presented.paths, initialExpansion: "open" });
      tree.cleanUp();
    }).not.toThrow();
  });

  it("rewrites a colliding file deeper than the first segment, and a chain of prefixes", () => {
    const nested = diffFileTreeModel(["src/office", "src/office/config.ts"]);
    expect(nested.modelPath("src/office")).not.toBe("src/office");
    expect(nested.modelPath("src/office/config.ts")).toBe("src/office/config.ts");
    expect(nested.selectionPath(nested.modelPath("src/office"))).toBe("src/office");

    const chain = diffFileTreeModel(["a", "a/b", "a/b/c"]);
    expect(chain.modelPath("a")).not.toBe("a");
    expect(chain.modelPath("a/b")).not.toBe("a/b");
    expect(chain.modelPath("a/b/c")).toBe("a/b/c");
    const tree = new FileTree({ paths: chain.paths, initialExpansion: "open" });
    expect(tree.getItem(chain.modelPath("a"))?.isDirectory()).toBe(false);
    expect(tree.getItem(chain.modelPath("a/b"))?.isDirectory()).toBe(false);
    expect(tree.getItem("a/b/c")?.isDirectory()).toBe(false);
    tree.cleanUp();
  });

  it("does not reuse a diff path that already ends with the file mark", () => {
    const marked = "office\u200b";
    const paths = ["office", marked, "office/config.ts"];
    const presented = diffFileTreeModel(paths);
    expect(new Set(presented.paths).size).toBe(paths.length);
    expect(presented.modelPath("office")).not.toBe(marked);
    expect(presented.selectionPath(presented.modelPath("office"))).toBe("office");
    expect(presented.selectionPath(presented.modelPath(marked))).toBe(marked);
    const tree = new FileTree({ paths: presented.paths, initialExpansion: "open" });
    expect(tree.getItem(presented.modelPath("office"))?.isDirectory()).toBe(false);
    expect(tree.getItem(presented.modelPath(marked))?.isDirectory()).toBe(false);
    expect(tree.getItem("office/config.ts")?.isDirectory()).toBe(false);
    tree.cleanUp();
  });

  it("rejects the raw colliding list and accepts a later slice once paths are safe", () => {
    const tree = new FileTree({ paths: ["office"], initialExpansion: "open" });
    expect(() =>
      tree.batch(buildDiffFileTreeUpdates(["office"], ["office", "office/config.ts"])),
    ).toThrow(/collides with an existing file/);

    const appended = diffFileTreeModel(["src/a.ts", "office", "office/config.ts"]);
    const updates = buildDiffFileTreeUpdates(["src/a.ts"], appended.paths);
    const appending = new FileTree({ paths: ["src/a.ts"], initialExpansion: "open" });
    expect(() => appending.batch(updates)).not.toThrow();
    expect(appending.getItem(appended.modelPath("office"))?.isDirectory()).toBe(false);
    expect(appending.getItem("office/config.ts")?.isDirectory()).toBe(false);

    const rewritten = diffFileTreeModel(["office", "office/config.ts"]);
    expect(() => tree.resetPaths(rewritten.paths)).not.toThrow();
    expect(tree.getItem(rewritten.modelPath("office"))?.isDirectory()).toBe(false);
    expect(tree.getItem("office/config.ts")?.isDirectory()).toBe(false);
    tree.cleanUp();
    appending.cleanUp();
  });
});
