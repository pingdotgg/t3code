import { describe, expect, it } from "vite-plus/test";

import { reviewPositionInPatch } from "./pullRequestReviewPosition.ts";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,3 @@ function a() {",
  " kept",
  "-removed",
  "+added",
  " also kept",
  "diff --git a/gone.ts b/gone.ts",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/other.ts b/other.ts",
  "--- a/other.ts",
  "+++ b/other.ts",
  "@@ -1 +1,2 @@",
  " first",
  // An added line reading `++ b/src/a.ts`, not a header for src/a.ts.
  "+++ b/src/a.ts",
  "@@ -20 +21 @@",
  " later",
].join("\n");

describe("reviewPositionInPatch", () => {
  it.each([
    ["an added line", "src/a.ts", 11, "new", { kind: "added", newLine: 11 }],
    ["a removed line", "src/a.ts", 11, "old", { kind: "deleted", oldLine: 11 }],
    [
      "a kept line by its head number",
      "src/a.ts",
      12,
      "new",
      { kind: "context", oldLine: 12, newLine: 12, side: "right" },
    ],
    [
      "a kept line by its base number",
      "src/a.ts",
      10,
      "old",
      { kind: "context", oldLine: 10, newLine: 10, side: "left" },
    ],
    ["a deleted file's line", "gone.ts", 1, "old", { kind: "deleted", oldLine: 1 }],
    ["a line outside every hunk", "src/a.ts", 30, "new", null],
    ["no line from a later file's header-like source", "src/a.ts", 21, "new", null],
    ["a line of a file the patch lacks", "src/b.ts", 11, "new", null],
  ] as const)("places %s", (_name, path, line, side, expected) => {
    expect(reviewPositionInPatch(patch, path, line, side)).toEqual(expected);
  });
});
