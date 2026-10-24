import { describe, expect, it } from "vite-plus/test";

import {
  buildNativeReviewDiffData,
  getCachedNativeReviewDiffData,
} from "./nativeReviewDiffAdapter";
import type { ReviewInlineComment } from "./reviewCommentSelection";
import { buildReviewParsedDiff } from "./reviewModel";

function makeComment(text: string): ReviewInlineComment {
  return {
    id: "comment-1",
    sectionId: "git:working-tree",
    sectionTitle: "Dirty worktree",
    filePath: "example.ts",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "-1",
    text,
    diff: "@@ -1,1 +1,0 @@\n-const before = 1;",
  };
}

function filesPatch(paths: ReadonlyArray<string>) {
  return paths
    .map((path) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1,2 +1,2 @@",
        '-const first = renderPanel({ label: "before", enabled: true });',
        '-const second = renderPanel({ label: "before", enabled: true });',
        '+const first = renderPanel({ label: "after", enabled: true });',
        '+const second = renderPanel({ label: "after", enabled: true });',
      ].join("\n"),
    )
    .join("\n");
}

describe("buildNativeReviewDiffData languages", () => {
  it.each([
    ["js", "javascript"],
    ["cjs", "javascript"],
    ["mjs", "javascript"],
    ["jsx", "jsx"],
    ["ts", "typescript"],
    ["mts", "typescript"],
    ["cts", "typescript"],
    ["tsx", "tsx"],
  ])("assigns %s files their syntax language when deleted", (extension, language) => {
    const path = `scripts/dev-runner.${extension}`;
    const data = buildNativeReviewDiffData(
      buildReviewParsedDiff(
        [
          `diff --git a/${path} b/${path}`,
          "deleted file mode 100644",
          `--- a/${path}`,
          "+++ /dev/null",
          "@@ -1,2 +0,0 @@",
          '-import process from "node:process";',
          "-const port = process.env.PORT;",
          "",
        ].join("\n"),
        "deleted-script-language",
      ),
    );

    expect(data.files).toMatchObject([{ path, language }]);
    expect(data.rows.filter((row) => row.kind === "line")).toMatchObject([
      { content: 'import process from "node:process";', change: "delete" },
      { content: "const port = process.env.PORT;", change: "delete" },
    ]);
  });
});

describe("getCachedNativeReviewDiffData", () => {
  it("keeps Pierre's matching lines in the GitHub credential pinning excerpt", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/packages/source-control-github/src/server/GitHubPullRequestApi.ts b/packages/source-control-github/src/server/GitHubPullRequestApi.ts",
        "--- a/packages/source-control-github/src/server/GitHubPullRequestApi.ts",
        "+++ b/packages/source-control-github/src/server/GitHubPullRequestApi.ts",
        "@@ -1221,11 +1240,4 @@",
        "-        operation: input.operation,",
        "-        path: input.path,",
        "-        ...(Option.isSome(previous) ? { ifNoneMatch: previous.value.etag } : {}),",
        "-      })",
        "-      .pipe(",
        "-        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {",
        "-          host,",
        "-          token,",
        "-          credentialFingerprint: fingerprint,",
        "-        }),",
        "-      );",
        "+        token,",
        "+        credentialFingerprint: fingerprint,",
        "+      }),",
        "+    );",
        "",
      ].join("\n"),
      "credential-pinning",
    );
    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") return;
    expect(
      parsed.files[0]?.rows.find((row) => row.kind === "line" && row.newLineNumber === 1242),
    ).toMatchObject({
      comparison: { change: "delete", tokenIndex: 9 },
    });
    const data = buildNativeReviewDiffData(parsed);
    expect(
      data.rows.find((row) => row.kind === "line" && row.newLineNumber === 1242)?.wordDiffRanges,
    ).toBeUndefined();
  });

  it.each([
    [true, false, "Old file has no newline at end of file."],
    [false, true, "New file has no newline at end of file."],
    [true, true, "Old and new files have no newline at end of file."],
    [false, false, null],
  ])("shows missing-newline notices for old=%s new=%s", (oldMissing, newMissing, notice) => {
    const data = buildNativeReviewDiffData(
      buildReviewParsedDiff(
        [
          "diff --git a/example.ts b/example.ts",
          "--- a/example.ts",
          "+++ b/example.ts",
          "@@ -1 +1 @@",
          "-value",
          ...(oldMissing ? ["\\ No newline at end of file"] : []),
          "+value",
          ...(newMissing ? ["\\ No newline at end of file"] : []),
          "",
        ].join("\n"),
        "native-eof",
      ),
    );
    expect(data.rows.filter((row) => row.kind === "notice").map((row) => row.text)).toEqual(
      notice ? [notice] : [],
    );
    expect(data.rows.filter((row) => row.kind === "line")).toHaveLength(2);
    expect(data.commentTargetsByRowId.size).toBe(2);
  });

  it("keeps cached IDs and targets local to each parsed section and file layout", () => {
    const original = filesPatch(["example.ts", "second.ts"]);
    const variants = [
      buildReviewParsedDiff(original, "first-section"),
      buildReviewParsedDiff(original, "second-section"),
      buildReviewParsedDiff(
        filesPatch(["inserted.ts", "example.ts", "second.ts"]),
        "first-section",
      ),
      buildReviewParsedDiff(filesPatch(["second.ts", "example.ts"]), "first-section"),
      buildReviewParsedDiff(filesPatch(["example.ts"]), "first-section"),
      buildReviewParsedDiff(
        original.replaceAll("@@ -1,2 +1,2 @@", "@@ -7,2 +12,2 @@"),
        "first-section",
      ),
    ];
    for (const diff of [...variants, variants[0]!]) {
      const input = { parsedDiff: diff, comments: [makeComment("Coordinates")] };
      expect(getCachedNativeReviewDiffData(input)).toEqual(buildNativeReviewDiffData(input));
    }
  });
});

describe("buildNativeReviewDiffData row bound", () => {
  function singleFilePatch(path: string, lineCount: number) {
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -0,0 +1,${lineCount} @@`,
      ...Array.from({ length: lineCount }, (_, index) => `+const value${index} = ${index};`),
    ].join("\n");
  }

  it("caps each huge file excerpt while preserving full counts and ordinary files", () => {
    const data = buildNativeReviewDiffData(
      buildReviewParsedDiff(
        [singleFilePatch("huge.ts", 200_000), singleFilePatch("ordinary.ts", 1_000)].join("\n"),
        "native-review-row-bound",
      ),
    );
    const hugeHeader = data.rows.find((row) => row.kind === "file" && row.filePath === "huge.ts");
    const ordinaryHeader = data.rows.find(
      (row) => row.kind === "file" && row.filePath === "ordinary.ts",
    );
    expect(hugeHeader).toMatchObject({ additions: 200_000, deletions: 0 });
    expect(ordinaryHeader).toMatchObject({ additions: 1_000, deletions: 0 });
    expect(data).toMatchObject({ additions: 201_000, deletions: 0 });
    const hugeRows = data.rows.filter((row) => row.fileId === hugeHeader?.fileId);
    expect(hugeRows.filter((row) => row.kind === "line" || row.kind === "hunk")).toHaveLength(
      2_000,
    );
    expect(hugeRows.at(-2)).toMatchObject({ kind: "line", newLineNumber: 1_999 });
    expect(hugeRows.at(-1)).toMatchObject({
      kind: "notice",
      text: "This diff is too large to show in full.",
    });
    const ordinaryRows = data.rows.filter((row) => row.fileId === ordinaryHeader?.fileId);
    expect(ordinaryRows.filter((row) => row.kind === "line")).toHaveLength(1_000);
    expect(ordinaryRows.at(-1)).toMatchObject({
      kind: "line",
      newLineNumber: 1_000,
      content: "const value999 = 999;",
    });
    expect(ordinaryRows.some((row) => row.kind === "notice")).toBe(false);
  });
});
