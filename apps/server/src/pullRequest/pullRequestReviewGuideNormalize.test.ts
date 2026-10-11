import { describe, expect, it } from "vite-plus/test";
import type { PullRequestReviewGuideStop } from "@t3tools/contracts";
import type { ReviewGuideGenerationResult } from "@t3tools/provider-core/server/textGeneration";

import { normalizeReviewGuide, parseReviewGuideChange } from "./pullRequestReviewGuideNormalize.ts";

// `git diff --unified=0` of: src/a.ts with lines 10-14 and 40-59 added and an old line 30
// removed; src/gone.ts deleted (old lines 1-20); docs/readme.md with line 3 added.
const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -9,0 +10,5 @@ export const x = 1;",
  "+added",
  "@@ -30 +34,0 @@ function y() {",
  "-removed",
  "@@ -35,0 +40,20 @@",
  "+added",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,20 +0,0 @@",
  "-removed",
  "diff --git a/docs/readme.md b/docs/readme.md",
  "--- a/docs/readme.md",
  "+++ b/docs/readme.md",
  "@@ -2,0 +3 @@",
  "+added",
  "",
].join("\n");
const change = parseReviewGuideChange("src/a.ts\0src/gone.ts\0docs/readme.md\0", patch);

const stop = (overrides: Partial<PullRequestReviewGuideStop>): PullRequestReviewGuideStop => ({
  title: "Stop",
  summary: "",
  attention: null,
  excerpts: [],
  files: [],
  notes: [],
  questions: [],
  ...overrides,
});

const guide = (overrides: Partial<ReviewGuideGenerationResult>): ReviewGuideGenerationResult => ({
  stops: [],
  ...overrides,
});

const excerpt = (path: string, start: number, end: number, side: "new" | "old" = "new") => ({
  path,
  side,
  start,
  end,
  caption: "",
});

describe("parseReviewGuideChange", () => {
  it("reads a removed or added line that looks like a file header as a source line", () => {
    const tricky = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -3,1 +3,2 @@",
      "--- a/old-heading",
      "+++ b/other.ts",
      "+tail",
      "@@ -9,0 +10,1 @@",
      "+later",
      "",
    ].join("\n");
    const parsed = parseReviewGuideChange("notes.md\0", tricky);
    expect([...parsed.hunks.keys()]).toEqual(["notes.md"]);
    expect(parsed.hunks.get("notes.md")).toEqual({
      new: [
        { start: 3, end: 4 },
        { start: 10, end: 10 },
      ],
      old: [{ start: 3, end: 3 }],
    });
  });

  it("reads each side's hunks, keying a deleted file by its old path", () => {
    expect(change.files).toEqual(["src/a.ts", "src/gone.ts", "docs/readme.md"]);
    expect(change.hunks.get("src/a.ts")).toEqual({
      new: [
        { start: 10, end: 14 },
        { start: 40, end: 59 },
      ],
      old: [{ start: 30, end: 30 }],
    });
    expect(change.hunks.get("src/gone.ts")).toEqual({ new: [], old: [{ start: 1, end: 20 }] });
    expect(change.hunks.get("docs/readme.md")).toEqual({ new: [{ start: 3, end: 3 }], old: [] });
  });
});

describe("normalizeReviewGuide", () => {
  it("clamps excerpts to changed lines, merges touching ones, and caps their length", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            excerpts: [
              // Starts on context before the hunk: clamped to the hunk.
              excerpt("src/a.ts", 5, 12),
              // Touches the previous one once clamped: merged.
              excerpt("src/a.ts", 13, 14),
              // Spans the whole second hunk and beyond: clamped to it.
              excerpt("src/a.ts", 38, 80),
              // On no changed line: dropped.
              excerpt("src/a.ts", 20, 25),
              // Removed code shown from the old side.
              excerpt("src/gone.ts", 2, 8, "old"),
            ],
            files: [{ path: "docs/readme.md", note: "" }],
          }),
        ],
      }),
      change,
    );
    expect(result.stops[0]?.excerpts).toEqual([
      excerpt("src/a.ts", 10, 14),
      excerpt("src/a.ts", 40, 59),
      excerpt("src/gone.ts", 2, 8, "old"),
    ]);
    expect(result.stops[0]?.files).toEqual([{ path: "docs/readme.md" }]);
    expect(result.stops).toHaveLength(1);
  });

  it("keeps a long excerpt to its first 25 lines", () => {
    const long = parseReviewGuideChange(
      "big.ts\0",
      "--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,100 @@\n",
    );
    const result = normalizeReviewGuide(
      guide({ stops: [stop({ excerpts: [excerpt("big.ts", 1, 100)] })] }),
      long,
    );
    expect(result.stops[0]?.excerpts).toEqual([excerpt("big.ts", 1, 25)]);
  });

  it("drops notes outside the stop's remaining excerpts", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            excerpts: [excerpt("src/a.ts", 5, 12)],
            notes: [
              { path: "src/a.ts", line: 11, title: "Inside", body: "" },
              { path: "src/a.ts", line: 6, title: "Clamped away", body: "" },
              { path: "src/other.ts", line: 11, title: "Other file", body: "" },
            ],
          }),
        ],
      }),
      change,
    );
    expect(result.stops[0]?.notes.map((note) => note.title)).toEqual(["Inside"]);
  });

  it("drops excerpts and files outside the change", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            excerpts: [excerpt("src/unchanged.ts", 1, 5)],
            files: [{ path: "src/a.ts", note: "edited" }, { path: "src/unchanged.ts" }],
          }),
        ],
      }),
      change,
    );
    expect(result.stops[0]?.excerpts).toEqual([]);
    expect(result.stops[0]?.files).toEqual([{ path: "src/a.ts", note: "edited" }]);
  });

  it("puts changed files the tour left out into a closing stop", () => {
    const result = normalizeReviewGuide(
      guide({ stops: [stop({ excerpts: [excerpt("src/a.ts", 10, 12)] })] }),
      change,
    );
    expect(result.stops.at(-1)).toMatchObject({
      title: "Other files",
      files: [{ path: "src/gone.ts" }, { path: "docs/readme.md" }],
    });
  });

  it("lets stops show different parts of one file and lists an unshown file once", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            title: "Shape",
            excerpts: [excerpt("src/a.ts", 10, 14)],
            files: [{ path: "docs/readme.md" }],
          }),
          stop({
            title: "Implementation",
            excerpts: [excerpt("src/a.ts", 40, 50)],
            files: [{ path: "src/a.ts" }, { path: "docs/readme.md" }, { path: "src/gone.ts" }],
          }),
        ],
      }),
      change,
    );
    expect(result.stops.map((s) => [s.title, s.excerpts.map((e) => e.start), s.files])).toEqual([
      ["Shape", [10], [{ path: "docs/readme.md" }]],
      ["Implementation", [40], [{ path: "src/gone.ts" }]],
    ]);
  });
});
