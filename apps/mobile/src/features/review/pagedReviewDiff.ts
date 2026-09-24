import { CHECKPOINT_DIFF_PAGE_ROWS, type CheckpointDiffPage } from "@t3tools/contracts";
import type { ReviewParsedDiff, ReviewRenderableRow } from "./reviewModel";
import type { ReviewRenderableLineRow } from "./reviewModel";
import {
  getReviewChangeMarker,
  getReviewUnifiedLineNumber,
  type LoadedReviewCommentSelection,
} from "./reviewCommentSelection";

/** Retain nearby and separately visible files without growing with the full diff. */
export function retainReviewDiffWindows(
  windows: ReadonlyArray<CheckpointDiffPage>,
  page: CheckpointDiffPage,
): ReadonlyArray<CheckpointDiffPage> {
  return [
    ...windows.filter((item) => item.revision === page.revision && item.start !== page.start),
    page,
  ].slice(-3);
}

export function mergeReviewDiffWindows(
  windows: ReadonlyArray<CheckpointDiffPage>,
): CheckpointDiffPage | undefined {
  const latest = windows.at(-1);
  if (!latest) return undefined;
  const rows = new Map(
    windows.flatMap((page) => page.rows.map((row) => [row.index, row] as const)),
  );
  return { ...latest, rows: [...rows.values()].sort((a, b) => a.index - b.index) };
}

export async function loadPagedReviewCommentSelection(input: {
  readonly start: number;
  readonly end: number;
  readonly revision: string;
  readonly fetchPage: (start: number) => Promise<CheckpointDiffPage>;
}): Promise<LoadedReviewCommentSelection> {
  const lines: ReviewRenderableLineRow[] = [];
  const chunks: string[] = [];
  let firstLine: ReviewRenderableLineRow | undefined;
  let lastLine: ReviewRenderableLineRow | undefined;
  let lineCount = 0;
  let oldStart = 0,
    newStart = 0,
    oldCount = 0,
    newCount = 0;
  let consistentChange = true;
  const end = Math.max(input.start, input.end);
  let start = Math.min(input.start, input.end);
  while (start <= end) {
    const page = await input.fetchPage(start);
    if (page.revision !== input.revision || page.rows.length === 0) {
      throw new Error("The diff changed while loading the selection. Select the range again.");
    }
    const parsed = buildPagedReviewParsedDiff(page);
    const chunk: string[] = [];
    if (parsed.kind === "files") {
      for (const file of parsed.files) {
        for (const row of file.rows) {
          if (
            row.kind === "line" &&
            row.sourceRow !== undefined &&
            row.sourceRow >= start &&
            row.sourceRow <= end
          ) {
            firstLine ??= row;
            lastLine = row;
            consistentChange &&= row.change === firstLine.change;
            if (lines.length < 5) lines.push(row);
            if (row.oldLineNumber !== null) {
              if (oldCount === 0) oldStart = row.oldLineNumber;
              oldCount += 1;
            }
            if (row.newLineNumber !== null) {
              if (newCount === 0) newStart = row.newLineNumber;
              newCount += 1;
            }
            lineCount += 1;
            chunk.push(getReviewChangeMarker(row.change) + row.content);
          }
        }
      }
    }
    if (chunk.length) chunks.push(chunk.join("\n"));
    start = page.rows.at(-1)!.index + 1;
  }
  if (!firstLine || !lastLine) throw new Error("The selected range contains no diff lines.");
  const marker = consistentChange ? getReviewChangeMarker(firstLine.change).trim() : "";
  const firstNumber = getReviewUnifiedLineNumber(firstLine);
  const lastNumber = getReviewUnifiedLineNumber(lastLine);
  const rangeLabel =
    firstNumber === null || lastNumber === null
      ? `${lineCount} lines`
      : firstNumber === lastNumber
        ? `${marker}${firstNumber}`
        : `${marker}${firstNumber} to ${marker}${lastNumber}`;
  return {
    lines,
    firstLine,
    lastLine,
    lineCount,
    rangeLabel,
    diff: [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...chunks].join("\n"),
  };
}

/** Keep a page behind and two pages ahead of the visible row. */
export function reviewDiffWindowStart(row: number): number {
  return Math.max(0, Math.floor(row / CHECKPOINT_DIFF_PAGE_ROWS) - 1) * CHECKPOINT_DIFF_PAGE_ROWS;
}

export function buildPagedReviewParsedDiff(page: CheckpointDiffPage): ReviewParsedDiff {
  if (page.files.length === 0) return { kind: "empty" };
  const rowsByFile = new Map<number, ReviewRenderableRow[]>();
  for (const row of page.rows) {
    const rows = rowsByFile.get(row.fileIndex) ?? [];
    rowsByFile.set(row.fileIndex, rows);
    const id = `${page.revision}:${row.index}`;
    rows.push(
      row.kind === "line"
        ? {
            kind: "line",
            id,
            sourceRow: row.index,
            sourceLineIndex: row.lineIndex,
            content: row.content,
            change: row.change,
            oldLineNumber: row.oldLineNumber,
            newLineNumber: row.newLineNumber,
            additionTokenIndex: null,
            deletionTokenIndex: null,
            comparison: null,
          }
        : { kind: "hunk", id, sourceRow: row.index, header: row.content, context: null },
    );
  }
  const files = page.files.map((file, index) => ({
    ...file,
    id: file.path,
    cacheKey: `${page.revision}:${index}`,
    languageHint: null,
    sourceRowStart: file.rowStart,
    sourceRowCount: file.rowCount,
    sourceLineCount: file.lineCount,
    sourceLineStarts: file.lineStarts,
    additionLines: [],
    deletionLines: [],
    rows: rowsByFile.get(index) ?? [],
  }));
  return {
    kind: "files",
    files,
    fileCount: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    notice: null,
  };
}
