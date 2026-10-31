import { describe, expect, it, vi } from "vite-plus/test";
import { diffWordsWithSpace } from "diff";
import { AsyncResult } from "effect/reactivity";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { EnvironmentId, ProjectId, type PullRequestDiffResult } from "@t3tools/contracts";

import { combinePullRequestDiffPages } from "../pull-requests/pullRequestDiffPages";
import { createPullRequestDiffHighlightFiles } from "../pull-requests/pullRequestDiffHighlightFiles";
import {
  buildNativeReviewDiffData,
  getCachedNativeReviewDiffData,
} from "./nativeReviewDiffAdapter";
import type { ReviewInlineComment } from "./reviewCommentSelection";
import { buildReviewParsedDiff, type ReviewParsedDiff } from "./reviewModel";

vi.mock("diff", { spy: true });

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
  it("keeps compact identities aligned through page append, filtering, comments, and source lookup", async () => {
    const scope = JSON.stringify({ remote: 'long-target\\"'.repeat(100) });
    const cache = new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
    const firstPage = {
      cursor: null,
      result: {
        patch: filesPatch(["example.ts", "hidden.test.ts"]),
        truncated: false,
        nextCursor: "next",
      },
    };
    const terminology = sourceControlClients.get("github").changeRequest;
    const first = combinePullRequestDiffPages([firstPage], cache, scope, terminology);
    if (first.kind !== "files") throw new Error("Expected parsed first page");
    const before = getCachedNativeReviewDiffData({ parsedDiff: first });
    const selectedRowId = before.rows.find((row) => row.kind === "line")!.id;
    const combined = combinePullRequestDiffPages(
      [
        firstPage,
        {
          cursor: "next",
          result: { patch: filesPatch(["last.ts"]), truncated: false, nextCursor: null },
        },
      ],
      cache,
      scope,
      terminology,
    );
    if (combined.kind !== "files") throw new Error("Expected parsed appended pages");
    expect(combined.files[0]).toBe(first.files[0]);
    const filtered = {
      ...combined,
      files: combined.files.filter((file) => !file.path.includes(".test.")),
    };
    const input = { parsedDiff: filtered, comments: [makeComment("Feedback")] };
    const data = getCachedNativeReviewDiffData(input);
    expect(getCachedNativeReviewDiffData(input)).toBe(data);
    expect(new Set(data.rows.map((row) => row.id)).size).toBe(data.rows.length);
    expect(data.rows.find((row) => row.id === selectedRowId)).toBe(
      before.rows.find((row) => row.id === selectedRowId),
    );
    // IDs used by native initialFileId/collapse and parsed source lookup share one namespace.
    expect(data.files.map((file) => file.id)).toEqual(filtered.files.map((file) => file.id));
    for (const file of filtered.files) {
      const header = data.rows.find((row) => row.kind === "file" && row.fileId === file.id)!;
      expect(header.filePath).toBe(file.path);
      const lines = file.rows.filter((row) => row.kind === "line");
      for (const [lineIndex, line] of lines.entries()) {
        const nativeId = data.rowIdByCommentLineId.get(line.id)!;
        const row = data.rows.find((row) => row.id === nativeId)!;
        expect(row.fileId).toBe(file.id);
        expect(row.content).toBe(line.content);
        expect(nativeId.length).toBeLessThan(64);
        const target = data.commentTargetsByRowId.get(nativeId)!;
        expect(target.filePath).toBe(file.path);
        expect(target.lines[lineIndex]).toBe(line);
        expect(target.lineIndex).toBe(lineIndex);
        expect(row.wordDiffRanges?.length).toBeGreaterThan(0);
        expect(
          row.wordDiffRanges?.map((range) => row.content!.slice(range.start, range.end)),
        ).toEqual([line.change === "delete" ? "before" : "after"]);
      }
    }
    const commentIndex = data.rows.findIndex((row) => row.id === "comment-1");
    expect(data.rows[commentIndex - 1]!.id).toBe(selectedRowId);
    expect(data.rows[commentIndex]!.fileId).toBe(first.files[0]!.id);

    const target = {
      environmentId: EnvironmentId.make("remote"),
      input: {
        projectId: ProjectId.make("project"),
        repository: "org/repo",
        number: 23,
      },
    };
    const contents = { oldContents: "old source", newContents: "new source" };
    const fetch = vi.fn(async () => AsyncResult.success(contents));
    const highlightFiles = createPullRequestDiffHighlightFiles(
      { target },
      filtered,
      data.files,
      fetch,
    );
    expect(await highlightFiles[1]!.loadContents!()).toBe(contents);
    expect(fetch).toHaveBeenCalledExactlyOnceWith({
      ...target,
      input: { ...target.input, changeType: "change", oldPath: "last.ts", newPath: "last.ts" },
    });
    expect(JSON.stringify(data.rows).length).toBeLessThan(5000);
  });

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
      100_000,
    );
    expect(hugeRows.at(-2)).toMatchObject({ kind: "line", newLineNumber: 99_999 });
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

describe("buildNativeReviewDiffData word comparison bound", () => {
  function modifiedFilePatch(pairCount: number, contextCount = 0) {
    const lineCount = pairCount + contextCount;
    return [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      `@@ -1,${lineCount} +1,${lineCount} @@`,
      ...Array.from({ length: contextCount }, (_, index) => ` const context${index} = true;`),
      ...Array.from(
        { length: pairCount },
        (_, index) => `-const value${index} = renderPanel({ label: "before", enabled: true });`,
      ),
      ...Array.from(
        { length: pairCount },
        (_, index) => `+const value${index} = renderPanel({ label: "after", enabled: true });`,
      ),
    ].join("\n");
  }

  it("bounds eager word comparisons without truncating a large modified file", () => {
    const parsedDiff = buildReviewParsedDiff(modifiedFilePatch(20_000), "native-word-bound");
    const comparisons = vi.mocked(diffWordsWithSpace).mockClear();
    const data = buildNativeReviewDiffData(parsedDiff);

    expect(comparisons).toHaveBeenCalledTimes(1_000);
    expect(data).toMatchObject({ additions: 20_000, deletions: 20_000 });
    const lines = data.rows.filter((row) => row.kind === "line");
    expect(lines).toHaveLength(40_000);
    expect(data.rows.some((row) => row.kind === "notice")).toBe(false);
    for (const offset of [0, 20_000]) {
      expect(lines[offset]?.wordDiffRanges?.length).toBeGreaterThan(0);
      expect(lines[offset + 999]?.wordDiffRanges?.length).toBeGreaterThan(0);
      expect(lines[offset + 1_000]?.wordDiffRanges).toBeUndefined();
    }
    expect(lines.at(-1)).toMatchObject({
      content: 'const value19999 = renderPanel({ label: "after", enabled: true });',
      newLineNumber: 20_000,
    });
    expect(data.commentTargetsByRowId.size).toBe(40_000);
    expect(data.commentTargetsByRowId.get(lines.at(-1)!.id)?.lineIndex).toBe(39_999);
  });

  it.each([0, 20_000])("preserves small word differences with %s context rows", (contextCount) => {
    const parsedDiff = buildReviewParsedDiff(
      modifiedFilePatch(2, contextCount),
      "native-word-context",
    );
    const comparisons = vi.mocked(diffWordsWithSpace).mockClear();
    const data = buildNativeReviewDiffData(parsedDiff);

    expect(comparisons).toHaveBeenCalledTimes(2);
    const changes = data.rows.filter((row) => row.kind === "line" && row.change !== "context");
    expect(changes).toHaveLength(4);
    for (const row of changes) {
      expect(
        row.wordDiffRanges?.map((range) => row.content!.slice(range.start, range.end)),
      ).toEqual([row.change === "delete" ? "before" : "after"]);
    }
  });
});
