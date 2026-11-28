import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { buildDiffFileTreeUpdates, diffFileTreeEntries } from "./diffFileTree.logic";

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
