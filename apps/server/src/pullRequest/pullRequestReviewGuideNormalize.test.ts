import { describe, expect, it } from "vite-plus/test";
import type { PullRequestReviewGuideStop } from "@t3tools/contracts";
import type { ReviewGuideGenerationResult } from "@t3tools/provider-core/server/textGeneration";

import {
  groupReviewGuideFiles,
  normalizeReviewGuide,
  parseReviewGuideChange,
} from "./pullRequestReviewGuideNormalize.ts";

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

describe("generated chapters", () => {
  it("moves all excerpts and notes for repeated generated output into one generated chapter", () => {
    const path = "src/_generated/sdk.ts";
    const note = { path, line: 22, title: "Generated field", body: "Derived from the schema." };
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            title: "Add the field",
            files: [{ path: "src/main.ts" }],
            excerpts: [excerpt(path, 1, 3)],
          }),
          stop({
            title: "Regenerate SDK",
            excerpts: [excerpt(path, 20, 25)],
            notes: [note],
          }),
        ],
      }),
      {
        files: ["src/main.ts", path],
        hunks: new Map([
          [
            path,
            {
              new: [
                { start: 1, end: 3 },
                { start: 20, end: 25 },
              ],
              old: [],
            },
          ],
        ]),
      },
    );
    const generated = result.stops.filter((chapter) =>
      chapter.excerpts.some((entry) => entry.path === path),
    );
    expect(generated).toHaveLength(1);
    expect(generated[0]?.excerpts).toEqual([excerpt(path, 1, 3), excerpt(path, 20, 25)]);
    expect(generated[0]?.notes).toEqual([note]);
    expect(result.stops[0]?.files).toEqual([{ path: "src/main.ts" }]);
    expect(result.stops[0]?.excerpts).toEqual([]);
  });

  it("separates generated files in mixed chapters and includes omitted lockfiles", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            title: "Source changes",
            files: [{ path: "src/main.ts" }, { path: "src/_generated/sdk.ts" }],
          }),
        ],
      }),
      { files: ["src/main.ts", "src/_generated/sdk.ts", "pnpm-lock.yaml"], hunks: new Map() },
    );
    expect(
      result.stops.map((chapter) => [chapter.title, chapter.files.map((file) => file.path)]),
    ).toEqual([
      ["Source changes", ["src/main.ts"]],
      ["Generated files", ["src/_generated/sdk.ts", "pnpm-lock.yaml"]],
    ]);
  });

  it("retains the model's useful descriptions for chapters that only contain generated output", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            title: "Refresh generated API",
            summary: "SDK regenerated after adding the field.",
            files: [{ path: "src/_generated/sdk.ts" }],
          }),
          stop({ title: "Add the field", files: [{ path: "src/main.ts" }] }),
        ],
      }),
      {
        files: ["src/main.ts", "src/_generated/sdk.ts"],
        hunks: new Map(),
      },
    );
    expect(result.stops.map((chapter) => chapter.title)).toEqual([
      "Add the field",
      "Refresh generated API",
    ]);
    expect(result.stops[1]?.summary).toBe("SDK regenerated after adding the field.");
  });
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
              excerpt("src/a.ts", 5, 12),
              excerpt("src/a.ts", 13, 14),
              excerpt("src/a.ts", 38, 80),
              excerpt("src/a.ts", 20, 25),
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

  it("keeps a file's shape and implementation in one chapter and lists unshown files once", () => {
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
            notes: [
              { path: "src/a.ts", line: 45, title: "Implementation detail", body: "Why it works." },
            ],
          }),
        ],
      }),
      change,
    );
    expect(result.stops.map((s) => [s.title, s.excerpts.map((e) => e.start), s.files])).toEqual([
      ["Shape", [10, 40], [{ path: "docs/readme.md" }]],
      ["Implementation", [], [{ path: "src/gone.ts" }]],
    ]);
    expect(result.stops[0]?.notes).toEqual([
      { path: "src/a.ts", line: 45, title: "Implementation detail", body: "Why it works." },
    ]);
    expect(result.stops[1]?.notes).toEqual([]);
  });
});

describe("groupReviewGuideFiles", () => {
  it("prefers an excerpt chapter over an earlier files-only mention and keeps old/new ranges together", () => {
    const original = [
      stop({ title: "Background", files: [{ path: "src/a.ts" }, { path: "docs/readme.md" }] }),
      stop({
        title: "Contract",
        excerpts: [excerpt("src/a.ts", 10, 14), excerpt("src/gone.ts", 2, 8, "old")],
      }),
      stop({
        title: "Implementation",
        excerpts: [
          { ...excerpt("src/a.ts", 30, 30, "old"), caption: "Previous contract" },
          { ...excerpt("src/a.ts", 40, 50), caption: "Implementation" },
        ],
        files: [{ path: "docs/readme.md" }],
        notes: [{ path: "src/a.ts", line: 45, title: "Important", body: "Keep this explanation." }],
      }),
    ];
    const result = groupReviewGuideFiles(original);
    expect(result[0]?.files).toEqual([{ path: "docs/readme.md" }]);
    expect(result[1]?.excerpts).toEqual([
      excerpt("src/a.ts", 10, 14),
      { ...excerpt("src/a.ts", 30, 30, "old"), caption: "Previous contract" },
      { ...excerpt("src/a.ts", 40, 50), caption: "Implementation" },
      excerpt("src/gone.ts", 2, 8, "old"),
    ]);
    expect(result[1]?.notes).toEqual(original[2]?.notes);
    expect(result[2]?.excerpts).toEqual([]);
    expect(result[2]?.files).toEqual([]);
    expect(result[2]?.notes).toEqual([]);
    expect(groupReviewGuideFiles(result)).toEqual(result);
    expect(original[0]?.files).toEqual([{ path: "src/a.ts" }, { path: "docs/readme.md" }]);
    expect(original[2]?.excerpts).toHaveLength(2);
  });

  it("does not merge separately anchored ranges when their combined length would drop notes", () => {
    const stops = [
      stop({ excerpts: [excerpt("src/a.ts", 1, 25)] }),
      stop({
        excerpts: [excerpt("src/a.ts", 26, 50)],
        notes: [{ path: "src/a.ts", line: 48, title: "Late anchor", body: "Still visible." }],
      }),
    ];
    const result = groupReviewGuideFiles(stops);
    expect(result[0]?.excerpts).toEqual([excerpt("src/a.ts", 1, 25), excerpt("src/a.ts", 26, 50)]);
    expect(result[0]?.notes).toEqual(stops[1]?.notes);
  });
});
