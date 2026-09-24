import { describe, expect, it } from "vite-plus/test";
import type { CheckpointDiffPage } from "@t3tools/contracts";
import {
  buildPagedReviewParsedDiff,
  loadPagedReviewCommentSelection,
  reviewDiffWindowStart,
  retainReviewDiffWindows,
  mergeReviewDiffWindows,
} from "./pagedReviewDiff";
import { buildNativeReviewDiffData } from "./nativeReviewDiffAdapter";

import {
  buildReviewCommentTarget,
  formatReviewCommentContext,
  parseReviewInlineComments,
} from "./reviewCommentSelection";

function page(start: number): CheckpointDiffPage {
  return {
    revision: "revision",
    rowCount: 200_000,
    start,
    files: [
      {
        path: "large.ts",
        previousPath: null,
        changeType: "new",
        additions: 200_000,
        deletions: 0,
        rowStart: 0,
        rowCount: 200_000,
        lineCount: 200_000,
        lineStarts: [{ lineIndex: 0, rowIndex: 0 }],
      },
    ],
    rows: Array.from({ length: Math.min(768, 200_000 - start) }, (_, i) => ({
      index: start + i,
      fileIndex: 0,
      kind: "line",
      content: `line ${start + i}`,
      change: "add",
      oldLineNumber: null,
      newLineNumber: start + i + 1,
      lineIndex: start + i,
    })),
  };
}

describe("paged mobile diffs", () => {
  it("preserves the scrollable preview for ordinary comment selections", async () => {
    const selection = await loadPagedReviewCommentSelection({
      start: 0,
      end: 9,
      revision: "revision",
      fetchPage: async (start) => page(start),
    });
    expect(selection.lines).toHaveLength(10);
    expect(selection.lineCount).toBe(10);
  });

  it("keeps a 200,000-line comment complete without retaining renderable rows for the whole range", async () => {
    const loadedSelection = await loadPagedReviewCommentSelection({
      start: 0,
      end: 199_999,
      revision: "revision",
      fetchPage: async (start) => page(start),
    });
    expect(loadedSelection.lines).toHaveLength(5);
    expect(loadedSelection.lineCount).toBe(200_000);
    const context = formatReviewCommentContext(
      {
        ...buildReviewCommentTarget(
          {
            sectionId: "turn:1",
            sectionTitle: "Turn 1",
            filePath: "large.ts",
            lines: loadedSelection.lines,
          },
          0,
          loadedSelection.lines.length - 1,
        ),
        loadedSelection,
      },
      "Review this range",
    );
    const comment = parseReviewInlineComments(context)[0]!;
    expect(comment.startIndex).toBe(0);
    expect(comment.endIndex).toBe(199_999);
    expect(comment.rangeLabel).toBe("+1 to +200000");
    expect(comment.diff.split("\n")).toHaveLength(200_001);
    expect(comment.diff).toContain("+line 100000");
    expect(comment.diff).toContain("+line 199999");
  });

  it("retains separated windows with exact placeholder spacing and a bounded cache", () => {
    let windows = retainReviewDiffWindows([], page(0));
    windows = retainReviewDiffWindows(windows, page(199_500));
    const merged = mergeReviewDiffWindows(windows)!;
    expect(merged.rows[0]!.index).toBe(0);
    expect(merged.rows.at(-1)!.index).toBe(199_999);
    const parsed = buildPagedReviewParsedDiff(merged);
    const native = buildNativeReviewDiffData(parsed);
    expect(
      native.rows
        .filter((row) => row.kind === "placeholder")
        .map((row) => [row.sourceRow, row.rowCount]),
    ).toEqual([[768, 199_500 - 768]]);
    windows = retainReviewDiffWindows(windows, page(1_000));
    windows = retainReviewDiffWindows(windows, page(2_000));
    expect(windows.map((window) => window.start)).toEqual([199_500, 1_000, 2_000]);
    expect(mergeReviewDiffWindows(windows)!.rows.length).toBeLessThanOrEqual(3 * 768);
    expect(retainReviewDiffWindows(windows, { ...page(0), revision: "new" })).toHaveLength(1);
  });

  it("loads an exact comment range across evicted windows, including reversed selections", async () => {
    const starts: number[] = [];
    const selection = await loadPagedReviewCommentSelection({
      start: 2000,
      end: 500,
      revision: "revision",
      fetchPage: async (start) => {
        starts.push(start);
        return page(start);
      },
    });
    expect(starts).toEqual([500, 1268]);
    expect(selection.lineCount).toBe(1501);
    expect(selection.lines).toHaveLength(5);
    expect(selection.firstLine.sourceLineIndex).toBe(500);
    expect(selection.lastLine.sourceLineIndex).toBe(2000);
    expect(selection.diff.split("\n")).toHaveLength(1502);
    expect(selection.diff).toContain("+line 2000");
    expect(selection.rangeLabel).toBe("+501 to +2001");
    await expect(
      loadPagedReviewCommentSelection({
        start: 0,
        end: 500,
        revision: "old",
        fetchPage: async (start) => page(start),
      }),
    ).rejects.toThrow("diff changed");
  });

  it("retains offscreen comments and their height while their lines are evicted", () => {
    const input = page(0);
    const comments = [
      {
        id: "comment",
        sectionId: "turn:1",
        sectionTitle: "Turn 1",
        filePath: "large.ts",
        startIndex: 1000,
        endIndex: 1000,
        rangeLabel: "+1001",
        text: "review",
        diff: "+line 1000",
      },
    ];
    for (const start of [0, 768, 20_000]) {
      const data = buildNativeReviewDiffData({
        parsedDiff: buildPagedReviewParsedDiff({ ...input, ...page(start) }),
        comments,
      });
      expect(data.rows.filter((row) => row.kind === "comment")).toHaveLength(1);
      expect(
        data.rows
          .filter((row) => row.kind !== "file" && row.kind !== "comment")
          .reduce((sum, row) => sum + (row.rowCount ?? 1), 0),
      ).toBe(200_000);
    }
  });

  it("keeps the full scroll extent with fewer than 800 native rows at the start, middle and end", () => {
    for (const start of [0, 99_840, 199_680]) {
      const data = buildNativeReviewDiffData(buildPagedReviewParsedDiff(page(start)));
      expect(data.rows.length).toBeLessThan(800);
      expect(
        data.rows
          .filter((row) => row.kind !== "file")
          .reduce((sum, row) => sum + (row.rowCount ?? 1), 0),
      ).toBe(200_000);
      expect(data.additions).toBe(200_000);
      expect(data.commentTargetsByRowId.size).toBeLessThanOrEqual(768);
    }
  });

  it("preserves row IDs and comment positions when a row moves between windows", () => {
    const first = buildNativeReviewDiffData(buildPagedReviewParsedDiff(page(0)));
    const next = buildNativeReviewDiffData({
      parsedDiff: buildPagedReviewParsedDiff(page(256)),
      comments: [
        {
          id: "comment",
          sectionId: "turn:1",
          sectionTitle: "Turn 1",
          filePath: "large.ts",
          startIndex: 500,
          endIndex: 500,
          rangeLabel: "+501",
          text: "review",
          diff: "+line 500",
        },
      ],
    });
    const oldRow = first.rows.find((row) => row.sourceRow === 500)!;
    const newIndex = next.rows.findIndex((row) => row.sourceRow === 500);
    expect(next.rows[newIndex]!.id).toBe(oldRow.id);
    expect(next.rows[newIndex + 1]).toMatchObject({ kind: "comment", id: "comment" });
    const target = next.commentTargetsByRowId.get(oldRow.id)!;
    expect(target.lines[target.lineIndex]).toMatchObject({
      sourceLineIndex: 500,
      newLineNumber: 501,
    });
    expect(
      buildNativeReviewDiffData(buildPagedReviewParsedDiff(page(0))).rows.find(
        (row) => row.sourceRow === 500,
      )!.id,
    ).toBe(oldRow.id);
  });

  it("requests a bounded window around a scroll or file jump", () => {
    expect(reviewDiffWindowStart(0)).toBe(0);
    expect(reviewDiffWindowStart(600)).toBe(256);
    expect(reviewDiffWindowStart(199_999)).toBe(199_680);
  });
});
