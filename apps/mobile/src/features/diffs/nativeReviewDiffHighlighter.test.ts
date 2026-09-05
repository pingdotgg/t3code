import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { NativeReviewDiffRow } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import {
  highlightNativeReviewDiffVisibleRows,
  streamNativeReviewDiffTokens,
  type NativeReviewDiffTokenChunk,
} from "./nativeReviewDiffHighlighter";

const tokenization = vi.hoisted(() => ({
  calls: [] as string[],
  afterCall: undefined as (() => void) | undefined,
}));

vi.mock("@shikijs/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shikijs/core")>();
  return {
    ...original,
    createHighlighterCore: async (...args: Parameters<typeof original.createHighlighterCore>) => {
      const highlighter = await original.createHighlighterCore(...args);
      return {
        ...highlighter,
        codeToTokensBase: (...input: Parameters<typeof highlighter.codeToTokensBase>) => {
          tokenization.calls.push(input[0]);
          const result = highlighter.codeToTokensBase(...input);
          tokenization.afterCall?.();
          return result;
        },
      };
    },
  };
});

// Exercise the native entry path without requiring an iOS or Android runtime.
vi.mock("react-native-shiki-engine", async () => {
  const { createJavaScriptRegexEngine } = await import("@shikijs/engine-javascript");
  return { isNativeEngineAvailable: () => true, createNativeEngine: createJavaScriptRegexEngine };
});

afterEach(() => {
  tokenization.calls = [];
  tokenization.afterCall = undefined;
});

const TYPESCRIPT_FILE: NativeReviewDiffFile = {
  id: "file-1",
  path: "example.ts",
  language: "typescript",
  additions: 0,
  deletions: 0,
};

function makeLine(
  input: Pick<NativeReviewDiffRow, "id" | "content" | "change" | "oldLineNumber" | "newLineNumber">,
): NativeReviewDiffRow {
  return {
    kind: "line",
    fileId: TYPESCRIPT_FILE.id,
    ...input,
  };
}

function makeHunk(id: string): NativeReviewDiffRow {
  return {
    kind: "hunk",
    id,
    fileId: TYPESCRIPT_FILE.id,
    text: "@@",
  };
}

function highlight(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  alreadyHighlightedRowIds?: ReadonlySet<string>,
) {
  return highlightNativeReviewDiffVisibleRows({
    rows,
    files: [TYPESCRIPT_FILE],
    scheme: "dark",
    engine: "javascript",
    firstRowIndex: 0,
    lastRowIndex: rows.length - 1,
    overscanRows: 0,
    maxRows: 100,
    alreadyHighlightedRowIds,
  });
}

describe("highlightNativeReviewDiffVisibleRows", () => {
  it("does not carry grammar state across hunk boundaries", async () => {
    const exportRow = makeLine({
      id: "export-row",
      content: "export async function run() {}",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 100,
    });
    const rows = [
      makeHunk("hunk-1"),
      makeLine({
        id: "import-open",
        content: "import {",
        change: "context",
        oldLineNumber: 1,
        newLineNumber: 1,
      }),
      makeLine({
        id: "import-entry",
        content: "  Model,",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 2,
      }),
      makeHunk("hunk-2"),
      exportRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows),
      highlight([makeHunk("standalone-hunk"), exportRow]),
    ]);

    expect(highlighted.tokensByRowId[exportRow.id]).toEqual(standalone.tokensByRowId[exportRow.id]);
  });

  it("keeps grammar state across inline comment rows", async () => {
    const openingRow = makeLine({
      id: "template-open",
      content: "const message = `open",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    const closingRow = makeLine({
      id: "template-close",
      content: "closed`;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 2,
    });
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const commentRow: NativeReviewDiffRow = {
      kind: "comment",
      id: "comment-1",
      fileId: TYPESCRIPT_FILE.id,
      commentText: "Review note",
    };

    const [withComment, contiguous] = await Promise.all([
      highlight([openingRow, commentRow, closingRow, trailingRow]),
      highlight([openingRow, closingRow, trailingRow]),
    ]);

    expect(withComment.tokensByRowId).toEqual(contiguous.tokensByRowId);
  });

  it("does not join unhighlighted rows across cached gaps", async () => {
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const rows = [
      makeLine({
        id: "template-open",
        content: "const message = `open",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
      }),
      makeLine({
        id: "template-close",
        content: "closed`;",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
      }),
      trailingRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows, new Set(["template-close"])),
      highlight([trailingRow]),
    ]);

    expect(highlighted.tokensByRowId[trailingRow.id]).toEqual(
      standalone.tokensByRowId[trailingRow.id],
    );
  });

  it("keeps deletion grammar state out of addition rows", async () => {
    const additionRow = makeLine({
      id: "addition-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    const rows = [
      makeLine({
        id: "deletion-row",
        content: "const removed = `open",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
      }),
      additionRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows),
      highlight([additionRow]),
    ]);

    expect(highlighted.tokensByRowId[additionRow.id]).toEqual(
      standalone.tokensByRowId[additionRow.id],
    );
  });
});

describe.each(["native", "javascript"] as const)("%s highlighting budgets", (engine) => {
  const highlightRows = (rows: ReadonlyArray<NativeReviewDiffRow>, signal?: AbortSignal) =>
    highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
      signal,
    });

  const line = (id: number, content: string) =>
    makeLine({
      id: `line-${id}`,
      content,
      change: "add",
      oldLineNumber: null,
      newLineNumber: id,
    });

  it("still highlights a line at the length limit", async () => {
    const content = `// ${"x".repeat(997)}`;
    const result = await highlightRows([line(1, content)]);

    expect(tokenization.calls).toEqual([content]);
    expect(result.tokensByRowId["line-1"]?.some((token) => token.color !== null)).toBe(true);
  });

  it("keeps long lines and unknown following syntax plain until the next hunk", async () => {
    const longLine = `${"x".repeat(1_001)} /*`;
    const rows = [
      line(1, "export const before = 1;"),
      line(2, longLine),
      { kind: "comment", id: "note", commentText: "Check this", fileId: TYPESCRIPT_FILE.id },
      line(3, "inside the comment */"),
      makeHunk("next-hunk"),
      line(100, "export const after = 2;"),
    ] satisfies ReadonlyArray<NativeReviewDiffRow>;
    const result = await highlightRows(rows);

    expect(result.engine).toBe(engine);
    expect(Object.keys(result.tokensByRowId)).toEqual(["line-1", "line-2", "line-3", "line-100"]);
    expect(result.tokensByRowId["line-2"]).toEqual([
      { content: longLine, color: null, fontStyle: null },
    ]);
    expect(result.tokensByRowId["line-3"]).toEqual([
      { content: "inside the comment */", color: null, fontStyle: null },
    ]);
    expect(result.tokensByRowId["line-1"]?.some((token) => token.color !== null)).toBe(true);
    expect(result.tokensByRowId["line-100"]?.some((token) => token.color !== null)).toBe(true);
    expect(tokenization.calls.some((code) => code.includes(longLine))).toBe(false);
  });

  it("preserves multiline grammar and row mapping across character-limited batches", async () => {
    const opening = line(1, "const message = `open");
    const body = Array.from({ length: 40 }, (_, index) => line(index + 2, "inside ".repeat(45)));
    const closing = line(42, "closed`; ");
    const trailing = line(43, "export const after = 2;");
    const result = await highlightRows([opening, ...body, closing, trailing]);
    const calls = [...tokenization.calls];
    const expected = await highlightRows([
      opening,
      { ...closing, newLineNumber: 2 },
      { ...trailing, newLineNumber: 3 },
    ]);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((code) => code.length <= 8_000)).toBe(true);
    expect(result.rowCount).toBe(43);
    for (const row of [opening, ...body, closing, trailing]) {
      expect(result.tokensByRowId[row.id]?.map((token) => token.content).join("")).toBe(
        row.content,
      );
    }
    expect(result.tokensByRowId[closing.id]).toEqual(expected.tokensByRowId[closing.id]);
    expect(result.tokensByRowId[trailing.id]).toEqual(expected.tokensByRowId[trailing.id]);
  });

  it("stops before later batches and publishes no partial result after cancellation", async () => {
    const controller = new AbortController();
    tokenization.afterCall = () => controller.abort();
    const rows = Array.from({ length: 30 }, (_, index) => line(index + 1, `// ${"x".repeat(400)}`));

    const result = await highlightRows(rows, controller.signal);

    expect(tokenization.calls).toHaveLength(1);
    expect(result.rowCount).toBe(0);
    expect(result.tokensByRowId).toEqual({});
  });

  it("applies the same long-line guard to streamed token chunks", async () => {
    const content = "x".repeat(10_000);
    const chunks: NativeReviewDiffTokenChunk[] = [];

    await streamNativeReviewDiffTokens({
      rows: [line(1, content)],
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tokensByRowId["line-1"]).toEqual([{ content, color: null, fontStyle: null }]);
    expect(tokenization.calls).toHaveLength(0);
  });
});
