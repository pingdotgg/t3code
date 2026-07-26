import { describe, expect, it } from "vite-plus/test";

import { parseDiffAnchors, resolveCommentAnchor } from "./diffAnchors.ts";

const RENAME_PATCH = [
  "diff --git a/old.ts b/new.ts",
  "similarity index 90%",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-dropped",
  "+added",
].join("\n");

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,5 @@ export function a() {",
  " const keep = 1;",
  "-const removed = 2;",
  "+const added = 2;",
  "+const alsoAdded = 3;",
  " return keep;",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const x = 1;",
  "+export const y = 2;",
].join("\n");

describe("parseDiffAnchors", () => {
  it("indexes added and context lines on the right side", () => {
    const anchors = parseDiffAnchors(PATCH);
    const file = anchors.get("src/a.ts");
    expect([...(file?.right ?? [])]).toEqual([10, 11, 12, 13]);
  });

  it("indexes removed and context lines on the left side", () => {
    const anchors = parseDiffAnchors(PATCH);
    const file = anchors.get("src/a.ts");
    expect([...(file?.left ?? [])]).toEqual([10, 11, 12]);
  });

  it("keys added files by their new path", () => {
    const anchors = parseDiffAnchors(PATCH);
    expect([...(anchors.get("src/new.ts")?.right ?? [])]).toEqual([1, 2]);
    expect(anchors.has("/dev/null")).toBe(false);
  });

  it("exposes a renamed file under both paths with both names recorded", () => {
    const anchors = parseDiffAnchors(RENAME_PATCH);
    expect(anchors.get("old.ts")).toBe(anchors.get("new.ts"));
    expect(anchors.get("new.ts")?.oldPath).toBe("old.ts");
    expect(anchors.get("new.ts")?.newPath).toBe("new.ts");
  });

  it("records a null counterpart path for adds and deletes", () => {
    const anchors = parseDiffAnchors(PATCH);
    expect(anchors.get("src/new.ts")?.oldPath).toBeNull();
    expect(anchors.get("src/new.ts")?.newPath).toBe("src/new.ts");
  });

  it("unquotes git's C-quoted paths", () => {
    const anchors = parseDiffAnchors(
      [
        'diff --git "a/dir/with space.ts" "b/dir/with space.ts"',
        '--- "a/dir/with space.ts"',
        '+++ "b/dir/with space.ts"',
        "@@ -1 +1 @@",
        "+changed",
      ].join("\n"),
    );
    expect(anchors.has("dir/with space.ts")).toBe(true);
  });

  it("stops trusting a hunk once the body ends", () => {
    const anchors = parseDiffAnchors(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,1 @@",
        "+one",
        "Binary files differ",
        "+two",
      ].join("\n"),
    );
    expect([...(anchors.get("a.ts")?.right ?? [])]).toEqual([1]);
  });

  it("returns nothing for an empty patch", () => {
    expect(parseDiffAnchors("").size).toBe(0);
  });
});

describe("resolveCommentAnchor", () => {
  const anchors = parseDiffAnchors(PATCH);

  it("accepts a right-side line inside the diff", () => {
    expect(resolveCommentAnchor({ anchors, path: "src/a.ts", line: 12, side: "RIGHT" })).toEqual({
      side: "RIGHT",
      path: "src/a.ts",
    });
  });

  it("rejects a line outside the diff", () => {
    expect(
      resolveCommentAnchor({ anchors, path: "src/a.ts", line: 400, side: "RIGHT" }),
    ).toBeNull();
  });

  it("rejects a right-side line that only exists on the left", () => {
    expect(resolveCommentAnchor({ anchors, path: "src/a.ts", line: 13, side: "LEFT" })).toBeNull();
  });

  it("prefers the right side when no side is given", () => {
    expect(resolveCommentAnchor({ anchors, path: "src/a.ts", line: 13, side: null })?.side).toBe(
      "RIGHT",
    );
  });

  it("tolerates leading ./ in model-supplied paths", () => {
    expect(resolveCommentAnchor({ anchors, path: "./src/a.ts", line: 11, side: null })).toEqual({
      side: "RIGHT",
      path: "src/a.ts",
    });
  });

  it("rejects unknown files and null lines", () => {
    expect(
      resolveCommentAnchor({ anchors, path: "src/missing.ts", line: 1, side: null }),
    ).toBeNull();
    expect(resolveCommentAnchor({ anchors, path: "src/a.ts", line: null, side: null })).toBeNull();
  });

  it("rewrites a renamed file's path to the side GitHub expects", () => {
    const renamed = parseDiffAnchors(RENAME_PATCH);
    // The model cites the pre-rename name; RIGHT must be posted as the new one.
    expect(resolveCommentAnchor({ anchors: renamed, path: "old.ts", line: 2, side: null })).toEqual(
      {
        side: "RIGHT",
        path: "new.ts",
      },
    );
    expect(
      resolveCommentAnchor({ anchors: renamed, path: "new.ts", line: 2, side: "LEFT" }),
    ).toEqual({ side: "LEFT", path: "old.ts" });
  });

  it("keeps the only known path for an added file", () => {
    expect(resolveCommentAnchor({ anchors, path: "src/new.ts", line: 1, side: null })).toEqual({
      side: "RIGHT",
      path: "src/new.ts",
    });
  });
});
