import { describe, expect, it } from "vite-plus/test";

import { parseNumstat, patchPaths, splitPatch } from "./PullRequestFixtures.ts";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1..2 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-diff --git a/not/a/header b/in/content",
  "+x",
  "diff --git a/old name.ts b/new name.ts",
  "similarity index 90%",
  "rename from old name.ts",
  "rename to new name.ts",
  "",
].join("\n");

describe("PullRequestFixtures", () => {
  it("splits a git diff into file patches and reads their paths, renames included", () => {
    const files = splitPatch(patch);
    expect(files).toHaveLength(2);
    expect(files.join("")).toBe(patch);
    expect(files.map(patchPaths)).toEqual([
      { oldPath: "src/a.ts", newPath: "src/a.ts" },
      { oldPath: "old name.ts", newPath: "new name.ts" },
    ]);
  });

  it("reads numstat -z output with renames and binary files", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\0-\t-\timage.png\x002\t0\t\0old.ts\0new.ts\0")).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "image.png", additions: 0, deletions: 0 },
      { path: "new.ts", additions: 2, deletions: 0 },
    ]);
  });
});
