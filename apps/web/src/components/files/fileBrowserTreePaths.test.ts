import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTreePaths } from "./fileBrowserTreePaths.ts";

describe("buildTreePaths", () => {
  it("maps files to plain paths and directories to trailing-slash paths", () => {
    const entries: ProjectEntry[] = [
      { path: "pkg", kind: "directory" },
      { path: "pkg/notes.txt", kind: "file" },
    ];

    expect(buildTreePaths(entries)).toEqual(["pkg/", "pkg/notes.txt"]);
  });

  it("drops duplicate paths so one bad entry cannot crash the tree", () => {
    // Duplicates should never arrive, but the tree model throws on them and
    // takes the whole panel down, so the mapping must be defensive.
    const entries: ProjectEntry[] = [
      { path: "pkg", kind: "directory" },
      { path: "pkg/notes.txt", kind: "file" },
      { path: "pkg/notes.txt", kind: "file" },
      { path: "pkg/other.txt", kind: "file" },
    ];

    expect(buildTreePaths(entries)).toEqual(["pkg/", "pkg/notes.txt", "pkg/other.txt"]);
  });
});
