import { describe, expect, it } from "vitest";

import {
  createProjectEntry,
  removeProjectListEntry,
  renameProjectListEntry,
  replaceExpandedDirectoryPrefix,
  upsertProjectListEntry,
} from "./projectExplorerEntries";

describe("projectExplorerEntries", () => {
  it("keeps optimistic list entries sorted with directories first", () => {
    const afterDirectory = upsertProjectListEntry(
      undefined,
      createProjectEntry("src", "directory"),
    );
    const afterFile = upsertProjectListEntry(afterDirectory, createProjectEntry("a.ts", "file"));
    const afterNestedFile = upsertProjectListEntry(
      afterFile,
      createProjectEntry("src/z.ts", "file"),
    );

    expect(afterNestedFile.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      "directory:src",
      "file:a.ts",
      "file:src/z.ts",
    ]);
  });

  it("renames entries while preserving list ordering", () => {
    const current = {
      entries: [createProjectEntry("src", "directory"), createProjectEntry("src/z.ts", "file")],
    };

    const renamed = renameProjectListEntry(current, {
      fromPath: "src/z.ts",
      toEntry: createProjectEntry("src/a.ts", "file"),
    });

    expect(renamed.entries.map((entry) => entry.path)).toEqual(["src", "src/a.ts"]);
  });

  it("removes entries without touching siblings", () => {
    const current = {
      entries: [createProjectEntry("src", "directory"), createProjectEntry("a.ts", "file")],
    };

    expect(removeProjectListEntry(current, "src").entries.map((entry) => entry.path)).toEqual([
      "a.ts",
    ]);
  });

  it("replaces expanded directory prefixes for rename and delete", () => {
    const paths = new Set(["src", "src/components", "docs"]);

    expect(
      [...replaceExpandedDirectoryPrefix(paths, { fromPrefix: "src", toPrefix: "lib" })].sort(),
    ).toEqual(["docs", "lib", "lib/components"]);
    expect(
      [...replaceExpandedDirectoryPrefix(paths, { fromPrefix: "src", toPrefix: null })].sort(),
    ).toEqual(["docs"]);
  });
});
