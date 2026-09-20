import type { FileDiffMetadata } from "@pierre/diffs";
import { preloadFileTree } from "@pierre/trees";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  changedPathParts,
  diffFileTreePositions,
  diffFileTreeViewedCounts,
  diffFileTreeEntries,
  orderFilesByTree,
} from "./diffFileTree.logic";

function file(type: FileDiffMetadata["type"], name: string, prevName = name): FileDiffMetadata {
  return { type, name, prevName } as FileDiffMetadata;
}

it("counts nested viewed files without including similar folder names", () => {
  const counts = diffFileTreeViewedCounts([
    { path: "src/a.ts", status: "modified", viewed: true },
    { path: "src/deep/b.ts", status: "added", viewedStale: true },
    { path: "src-other/c.ts", status: "deleted", viewed: true },
    { path: "README.md", status: "modified" },
  ]);
  expect(counts.get("src/")).toEqual({ total: 2, viewed: 1, stale: 1 });
  expect(counts.get("src/deep/")).toEqual({ total: 1, viewed: 0, stale: 1 });
  expect(counts.get("src-other/")).toEqual({ total: 1, viewed: 1, stale: 0 });
  expect(counts.get("README.md")).toEqual({ total: 1, viewed: 0, stale: 0 });
});

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
      {
        path: "src/c.ts",
        status: "renamed",
        previousPath: "src/old-c.ts",
        renamedWithChanges: false,
      },
      {
        path: "src/d.ts",
        status: "renamed",
        previousPath: "src/old-d.ts",
        renamedWithChanges: true,
      },
      { path: "README.md", status: "modified" },
    ]);
  });
});

describe("changedPathParts", () => {
  it.each([
    [
      "src/quality-control.ts",
      "src/issues.ts",
      { prefix: "src/", before: "quality-control", after: "issues", suffix: ".ts" },
    ],
    ["old/file.ts", "new/file.ts", { prefix: "", before: "old", after: "new", suffix: "/file.ts" }],
    [
      "src/file.ts",
      "src/new-file.ts",
      { prefix: "src/", before: "", after: "new-", suffix: "file.ts" },
    ],
    [
      "src/new-file.ts",
      "src/file.ts",
      { prefix: "src/", before: "new-", after: "", suffix: "file.ts" },
    ],
    ["src/😀.ts", "src/😁.ts", { prefix: "src/", before: "😀", after: "😁", suffix: ".ts" }],
    ["src/file.ts", "src/file.ts", { prefix: "src/file.ts", before: "", after: "", suffix: "" }],
  ])("isolates the changed part of %s → %s", (previousPath, path, expected) => {
    const parts = changedPathParts(previousPath, path);
    expect(parts).toEqual(expected);
    expect(parts.prefix + parts.before + parts.suffix).toBe(previousPath);
    expect(parts.prefix + parts.after + parts.suffix).toBe(path);
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
  it("keeps nested folders contiguous using the first file in review order", () => {
    const paths = ["lib/b.ts", "ui/a.ts", "lib/c.ts", "ui/a.test.ts", "lib/b.test.ts", "lock"];
    expect(orderFilesByTree(paths, (path) => path)).toEqual([
      "lib/b.ts",
      "lib/c.ts",
      "lib/b.test.ts",
      "ui/a.ts",
      "ui/a.test.ts",
      "lock",
    ]);
    expect(orderFilesByTree(paths.toReversed(), (path) => path)).toEqual([
      "lock",
      "lib/b.test.ts",
      "lib/c.ts",
      "lib/b.ts",
      "ui/a.test.ts",
      "ui/a.ts",
    ]);
  });

  it("keeps both sides of a type change and handles empty input", () => {
    const removed = file("deleted", "src/app.ts");
    const added = file("new", "src/app.ts");
    expect(
      orderFilesByTree([removed, file("change", "README.md"), added], (file) => file.name),
    ).toEqual([removed, added, file("change", "README.md")]);
    expect(orderFilesByTree([], String)).toEqual([]);
  });

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
