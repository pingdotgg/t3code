import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDiffFileTreeUpdates,
  diffFileListModel,
  diffFileTreeEntries,
} from "./diffFileTree.logic";

function file(type: FileDiffMetadata["type"], name: string, prevName = name): FileDiffMetadata {
  return { type, name, prevName } as FileDiffMetadata;
}

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
});

describe("diffFileListModel", () => {
  it("names each file by its basename and keeps repeated names apart", () => {
    const list = diffFileListModel(["src/index.ts", "docs/README.md", "test/Index.ts"]);
    expect(list.paths.map((path) => path.replace(/[\u200b\u200c\u2060]/g, ""))).toEqual([
      "index.ts",
      "README.md",
      "Index.ts",
    ]);
    expect(new Set(list.paths.map((path) => path.toLowerCase())).size).toBe(3);
    expect(list.paths.map(list.selectionPath)).toEqual([
      "src/index.ts",
      "docs/README.md",
      "test/Index.ts",
    ]);
    expect(list.modelPath("test/Index.ts")).toBe(list.paths[2]);
    // A missing root file must not resolve to the row of a same-named file in a folder.
    expect(diffFileListModel(["dir/index.ts"]).modelPath("index.ts")).toBeUndefined();
  });

  it("keeps a repeated name's id short", () => {
    const paths = Array.from({ length: 1000 }, (_, index) => `dir${index}/index.ts`);
    const list = diffFileListModel(paths);
    expect(new Set(list.paths).size).toBe(1000);
    expect(Math.max(...list.paths.map((path) => path.length))).toBeLessThan(24);
  });
});
