import { describe, expect, it } from "vite-plus/test";

import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";

import { changeSetOf, firstChangedLine } from "./changeSet";

const preview = {
  diff: "",
  files: [
    { path: "src/new.ts", previousPath: null, changeType: "new", additions: 10, deletions: 0 },
    {
      path: "src/app/main.ts",
      previousPath: null,
      changeType: "change",
      additions: 3,
      deletions: 1,
    },
    {
      path: "docs/guide.md",
      previousPath: "docs/old.md",
      changeType: "rename-changed",
      additions: 2,
      deletions: 2,
    },
    { path: "README.md", previousPath: null, changeType: "deleted", additions: 0, deletions: 5 },
  ],
} as const;

describe("changeSetOf", () => {
  it("Given an added, a modified, a renamed, and a deleted file, when the set is built, then folders come first with summed counts", () => {
    expect(changeSetOf({ ...preview, files: [...preview.files] })).toEqual({
      tree: [
        {
          kind: "dir",
          name: "docs",
          path: "docs",
          additions: 2,
          deletions: 2,
          children: [
            {
              kind: "file",
              name: "guide.md",
              path: "docs/guide.md",
              previousPath: "docs/old.md",
              change: "renamed",
              additions: 2,
              deletions: 2,
            },
          ],
        },
        {
          kind: "dir",
          name: "src",
          path: "src",
          additions: 13,
          deletions: 1,
          children: [
            {
              kind: "dir",
              name: "app",
              path: "src/app",
              additions: 3,
              deletions: 1,
              children: [
                {
                  kind: "file",
                  name: "main.ts",
                  path: "src/app/main.ts",
                  previousPath: null,
                  change: "modified",
                  additions: 3,
                  deletions: 1,
                },
              ],
            },
            {
              kind: "file",
              name: "new.ts",
              path: "src/new.ts",
              previousPath: null,
              change: "added",
              additions: 10,
              deletions: 0,
            },
          ],
        },
        {
          kind: "file",
          name: "README.md",
          path: "README.md",
          previousPath: null,
          change: "deleted",
          additions: 0,
          deletions: 5,
        },
      ],
      files: [
        expect.objectContaining({ path: "docs/guide.md" }),
        expect.objectContaining({ path: "src/app/main.ts" }),
        expect.objectContaining({ path: "src/new.ts" }),
        expect.objectContaining({ path: "README.md" }),
      ],
      totals: { files: 4, additions: 15, deletions: 8 },
    });
  });

  it("Given a preview without its file list, when the set is built, then the counts come from the patch", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+more",
      "",
    ].join("\n");

    const set = changeSetOf({ diff });

    expect(set.files).toEqual([
      {
        kind: "file",
        name: "a.txt",
        path: "a.txt",
        previousPath: null,
        change: "modified",
        additions: 2,
        deletions: 1,
      },
    ]);
    expect(set.totals).toEqual({ files: 1, additions: 2, deletions: 1 });
  });

  it("Given an older server's change without a type, when it has a previous path, then it reads as renamed", () => {
    const set = changeSetOf({
      diff: "",
      files: [{ path: "b.ts", previousPath: "a.ts", additions: 0, deletions: 0 }],
    });

    expect(set.files[0]?.change).toBe("renamed");
  });
});

describe("firstChangedLine", () => {
  it("Given a hunk with three lines of context before its change, when the line is read, then it skips the context", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -10,4 +10,5 @@",
      " one",
      " two",
      " three",
      "+four",
      " five",
      "",
    ].join("\n");
    const [file] = parsePatchFiles(patch).flatMap((parsed) => parsed.files);

    expect(file && firstChangedLine(file)).toBe(13);
  });
});
