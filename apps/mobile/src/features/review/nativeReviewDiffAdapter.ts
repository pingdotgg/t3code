import type { NativeReviewDiffRow, NativeReviewDiffTheme } from "../diffs/nativeReviewDiffSurface";
import type {
  NativeReviewDiffFile,
  NativeReviewDiffLanguage,
} from "../diffs/nativeReviewDiffTypes";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import type { ResolvedMobileCodeSurface } from "../../lib/appearancePreferences";
import { resolveMobileCodeSurface } from "../../lib/appearancePreferences";
import { MOBILE_CODE_SURFACE } from "../../lib/typography";
import { getPierreTerminalTheme, type TerminalAppearanceScheme } from "../terminal/terminalTheme";
import { computeWordAltDiffRanges } from "./reviewWordDiffs";
import {
  getReviewFilePreviewState,
  type ReviewParsedDiff,
  type ReviewRenderableFile,
  type ReviewRenderableLineRow,
} from "./reviewModel";
import type { ReviewInlineComment } from "./reviewCommentSelection";

const NATIVE_REVIEW_MAX_WORD_DIFF_RANGE_COUNT = 4;
const NATIVE_REVIEW_MAX_WORD_DIFF_COVERAGE = 0.45;

export const NATIVE_REVIEW_DIFF_ROW_HEIGHT = MOBILE_CODE_SURFACE.rowHeight;
export const NATIVE_REVIEW_DIFF_CONTENT_WIDTH = 2_800;

export const NATIVE_REVIEW_DIFF_STYLE = createNativeReviewDiffStyle(
  resolveMobileCodeSurface(MOBILE_CODE_SURFACE.fontSize),
);

export function createNativeReviewDiffStyle(codeSurface: ResolvedMobileCodeSurface) {
  return {
    rowHeight: codeSurface.rowHeight,
    contentWidth: NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
    changeBarWidth: 4,
    gutterWidth: codeSurface.gutterWidth,
    codePadding: codeSurface.codePadding,
    textVerticalInset: codeSurface.textVerticalInset,
    fileHeaderHeight: 56,
    fileHeaderHorizontalMargin: 8,
    fileHeaderVerticalMargin: 6,
    fileHeaderCornerRadius: 10,
    fileHeaderHorizontalPadding: 10,
    fileHeaderPathRightPadding: 118,
    fileHeaderCountColumnWidth: 38,
    fileHeaderCountGap: 5,
    codeFontSize: codeSurface.fontSize,
    codeFontWeight: "regular",
    lineNumberFontSize: codeSurface.lineNumberFontSize,
    lineNumberFontWeight: "regular",
    hunkFontSize: 11,
    hunkFontWeight: "medium",
    fileHeaderFontSize: 11,
    fileHeaderFontWeight: "semibold",
    fileHeaderMetaFontSize: 10,
    fileHeaderMetaFontWeight: "semibold",
    fileHeaderSubtextFontSize: 11,
    fileHeaderSubtextFontWeight: "medium",
    fileHeaderStatusFontSize: 9,
    fileHeaderStatusFontWeight: "bold",
    emptyStateFontSize: 12,
    emptyStateFontWeight: "medium",
  } as const;
}

export interface NativeReviewDiffData {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly commentTargetsByRowId: ReadonlyMap<string, NativeReviewDiffCommentTarget>;
  readonly rowIdByCommentLineId: ReadonlyMap<string, string>;
  readonly additions: number;
  readonly deletions: number;
}

export interface NativeReviewDiffCommentTarget {
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly lineIndex: number;
}

export interface BuildNativeReviewDiffDataInput {
  readonly parsedDiff: ReviewParsedDiff;
  readonly comments?: ReadonlyArray<ReviewInlineComment>;
}

interface CachedNativeReviewDiffData {
  readonly commentsKey: string;
  readonly data: NativeReviewDiffData;
}

const nativeReviewDiffDataCache = new WeakMap<ReviewParsedDiff, CachedNativeReviewDiffData>();

function buildReviewCommentsCacheKey(comments: ReadonlyArray<ReviewInlineComment>): string {
  if (comments.length === 0) {
    return "none";
  }

  return comments
    .map((comment) =>
      [
        comment.id,
        comment.sectionId,
        comment.filePath,
        comment.startIndex,
        comment.endIndex,
        comment.rangeLabel,
        comment.text,
      ].join("\u001f"),
    )
    .join("\u001e");
}

export function createNativeReviewDiffTheme(
  scheme: TerminalAppearanceScheme,
): NativeReviewDiffTheme {
  const terminalTheme = getPierreTerminalTheme(scheme);
  const [, terminalRed, , , terminalBlue] = terminalTheme.palette;

  if (scheme === "dark") {
    return {
      // Match the app surface (--color-sheet) so code views blend with the rest of
      // the app instead of using a distinct code-editor background.
      background: "#0e0e0e",
      text: terminalTheme.foreground,
      mutedText: terminalTheme.mutedForeground,
      headerBackground: "#0e0e0e",
      border: terminalTheme.border,
      hunkBackground: "#071f28",
      hunkText: terminalBlue ?? "#009fff",
      addBackground: "#0d2f28",
      deleteBackground: "#391415",
      addBar: "#00cab1",
      deleteBar: terminalRed ?? "#ff2e3f",
      addText: "#5ECC71",
      deleteText: "#FF6762",
    };
  }

  return {
    // Match the app surface (--color-sheet) so code views blend with the rest of the
    // app instead of using a distinct code-editor background.
    background: "#f2f2f7",
    text: "#070707",
    mutedText: terminalTheme.mutedForeground,
    headerBackground: "#f2f2f7",
    border: terminalTheme.border,
    hunkBackground: "#e0f2ff",
    hunkText: terminalBlue ?? "#009fff",
    addBackground: "#e5f8f5",
    deleteBackground: "#ffe6e7",
    addBar: "#00cab1",
    deleteBar: terminalRed ?? "#ff2e3f",
    addText: "#199F43",
    deleteText: "#D52C36",
  };
}

function mapChangeType(file: ReviewRenderableFile): NativeReviewDiffRow["changeType"] {
  switch (file.changeType) {
    case "change":
      return "modified";
    case "new":
    case "deleted":
    case "rename-pure":
    case "rename-changed":
      return file.changeType;
    default:
      return "modified";
  }
}

function getLanguageForPath(
  filePath: string,
  languageHint: string | null,
): NativeReviewDiffLanguage {
  const hinted = languageHint?.toLowerCase();
  if (hinted === "typescript" || hinted === "tsx" || hinted === "javascript" || hinted === "jsx") {
    return hinted;
  }
  if (hinted === "json" || hinted === "yaml" || hinted === "bash" || hinted === "diff") {
    return hinted;
  }

  const normalizedPath = filePath.toLowerCase();
  if (normalizedPath.endsWith(".tsx")) return "tsx";
  if (normalizedPath.endsWith(".ts")) return "typescript";
  if (normalizedPath.endsWith(".jsx")) return "jsx";
  if (normalizedPath.endsWith(".js") || normalizedPath.endsWith(".cjs")) return "javascript";
  if (normalizedPath.endsWith(".json") || normalizedPath.endsWith(".jsonc")) return "json";
  if (normalizedPath.endsWith(".yml") || normalizedPath.endsWith(".yaml")) return "yaml";
  if (
    normalizedPath.endsWith(".sh") ||
    normalizedPath.includes("/bin/") ||
    normalizedPath.includes("shell")
  ) {
    return "bash";
  }
  return "diff";
}

function createNoticeRow(fileId: string, suffix: string, text: string): NativeReviewDiffRow {
  return {
    kind: "notice",
    id: `${fileId}:notice:${suffix}`,
    fileId,
    text,
  };
}

function noticeRowsForFile(file: ReviewRenderableFile): ReadonlyArray<NativeReviewDiffRow> {
  if (file.rows.length > 0) {
    return [];
  }

  const previewState = getReviewFilePreviewState(file);
  if (previewState.kind === "suppressed" && previewState.reason === "non-text") {
    return [
      createNoticeRow(file.id, "non-text", "Unsupported format. Diff contents are not available."),
    ];
  }

  if (file.changeType === "rename-pure") {
    return [createNoticeRow(file.id, "rename", "This file was renamed without modifications.")];
  }

  return [];
}

function trimWordDiffRanges(
  content: string,
  ranges: NonNullable<NativeReviewDiffRow["wordDiffRanges"]>,
): NonNullable<NativeReviewDiffRow["wordDiffRanges"]> {
  return pipe(
    ranges,
    Arr.flatMap((range) => {
      let start = Math.max(0, range.start);
      let end = Math.min(content.length, range.end);

      while (start < end && /\s/.test(content[start] ?? "")) {
        start += 1;
      }
      while (end > start && /\s/.test(content[end - 1] ?? "")) {
        end -= 1;
      }

      return end > start ? [{ start, end }] : [];
    }),
  );
}

function nonWhitespaceLength(value: string) {
  return value.replace(/\s/g, "").length;
}

function shouldUseWordDiffRanges(
  content: string,
  ranges: NonNullable<NativeReviewDiffRow["wordDiffRanges"]>,
) {
  if (ranges.length === 0 || ranges.length > NATIVE_REVIEW_MAX_WORD_DIFF_RANGE_COUNT) {
    return false;
  }

  const meaningfulLength = nonWhitespaceLength(content);
  if (meaningfulLength === 0) {
    return false;
  }

  const highlightedLength = ranges.reduce(
    (total, range) => total + nonWhitespaceLength(content.slice(range.start, range.end)),
    0,
  );
  return highlightedLength / meaningfulLength <= NATIVE_REVIEW_MAX_WORD_DIFF_COVERAGE;
}

function addNativeWordDiffRanges(
  rows: ReadonlyArray<NativeReviewDiffRow>,
): ReadonlyArray<NativeReviewDiffRow> {
  const nextRows = [...rows];
  let index = 0;

  while (index < nextRows.length) {
    const deletedRowIndexes: number[] = [];
    const addedRowIndexes: number[] = [];
    const fileId = nextRows[index]?.fileId;

    while (
      nextRows[index]?.kind === "line" &&
      nextRows[index]?.change === "delete" &&
      nextRows[index]?.fileId === fileId
    ) {
      deletedRowIndexes.push(index);
      index += 1;
    }

    while (
      nextRows[index]?.kind === "line" &&
      nextRows[index]?.change === "add" &&
      nextRows[index]?.fileId === fileId
    ) {
      addedRowIndexes.push(index);
      index += 1;
    }

    const pairedCount = Math.min(deletedRowIndexes.length, addedRowIndexes.length);
    for (let pairIndex = 0; pairIndex < pairedCount; pairIndex += 1) {
      const deletedRowIndex = deletedRowIndexes[pairIndex];
      const addedRowIndex = addedRowIndexes[pairIndex];
      const deletedRow = nextRows[deletedRowIndex];
      const addedRow = nextRows[addedRowIndex];
      if (!deletedRow?.content || !addedRow?.content) {
        continue;
      }

      const ranges = computeWordAltDiffRanges({
        deletionLine: deletedRow.content,
        additionLine: addedRow.content,
      });
      const deletionRanges = trimWordDiffRanges(deletedRow.content, ranges.deletion);
      const additionRanges = trimWordDiffRanges(addedRow.content, ranges.addition);

      if (shouldUseWordDiffRanges(deletedRow.content, deletionRanges)) {
        nextRows[deletedRowIndex] = { ...deletedRow, wordDiffRanges: deletionRanges };
      }
      if (shouldUseWordDiffRanges(addedRow.content, additionRanges)) {
        nextRows[addedRowIndex] = { ...addedRow, wordDiffRanges: additionRanges };
      }
    }

    if (deletedRowIndexes.length === 0 && addedRowIndexes.length === 0) {
      index += 1;
    }
  }

  return nextRows;
}

function mapLineRow(
  file: ReviewRenderableFile,
  row: ReviewRenderableLineRow,
  rowIndex: number,
): NativeReviewDiffRow {
  return {
    kind: "line",
    id: `${file.id}:line:${rowIndex}:${row.id}`,
    fileId: file.id,
    content: row.content,
    change: row.change,
    oldLineNumber: row.oldLineNumber,
    newLineNumber: row.newLineNumber,
  };
}

function mapFileRows(
  file: ReviewRenderableFile,
  comments: ReadonlyArray<ReviewInlineComment>,
  commentTargetsByRowId: Map<string, NativeReviewDiffCommentTarget>,
  rowIdByCommentLineId: Map<string, string>,
): ReadonlyArray<NativeReviewDiffRow> {
  const rows: NativeReviewDiffRow[] = [
    {
      kind: "file",
      id: `${file.id}:header`,
      fileId: file.id,
      filePath: file.path,
      previousPath: file.previousPath,
      changeType: mapChangeType(file),
      additions: file.additions,
      deletions: file.deletions,
    },
  ];

  const lineRows = file.rows.filter((row): row is ReviewRenderableLineRow => row.kind === "line");
  const commentsByEndIndex = new Map<number, ReviewInlineComment[]>();
  comments.forEach((comment) => {
    if (comment.filePath !== file.path) {
      return;
    }
    const endIndex = Math.min(comment.endIndex, lineRows.length - 1);
    if (endIndex < 0) {
      return;
    }
    const existing = commentsByEndIndex.get(endIndex);
    if (existing) {
      existing.push(comment);
      return;
    }
    commentsByEndIndex.set(endIndex, [comment]);
  });
  let lineIndex = 0;
  file.rows.forEach((row, rowIndex) => {
    if (row.kind === "hunk") {
      rows.push({
        kind: "hunk",
        id: `${file.id}:hunk:${rowIndex}:${row.id}`,
        fileId: file.id,
        text: row.context ? `${row.header} ${row.context}` : row.header,
      });
      return;
    }

    const nativeRow = mapLineRow(file, row, rowIndex);
    rows.push(nativeRow);
    rowIdByCommentLineId.set(row.id, nativeRow.id);
    commentTargetsByRowId.set(nativeRow.id, {
      filePath: file.path,
      lines: lineRows,
      lineIndex,
    });
    const commentsForLine = commentsByEndIndex.get(lineIndex) ?? [];
    for (const comment of commentsForLine) {
      rows.push({
        kind: "comment",
        id: comment.id,
        fileId: file.id,
        filePath: file.path,
        commentText: comment.text,
        commentRangeLabel: comment.rangeLabel,
        commentSectionTitle: comment.sectionTitle,
      });
    }
    lineIndex += 1;
  });

  rows.push(...noticeRowsForFile(file));
  return rows;
}

export function buildNativeReviewDiffData(
  input: BuildNativeReviewDiffDataInput,
): NativeReviewDiffData;
export function buildNativeReviewDiffData(parsedDiff: ReviewParsedDiff): NativeReviewDiffData;
export function buildNativeReviewDiffData(
  input: ReviewParsedDiff | BuildNativeReviewDiffDataInput,
): NativeReviewDiffData {
  const parsedDiff = "parsedDiff" in input ? input.parsedDiff : input;
  const comments = "parsedDiff" in input ? (input.comments ?? []) : [];
  if (parsedDiff.kind !== "files") {
    return {
      rows: [],
      files: [],
      commentTargetsByRowId: new Map(),
      rowIdByCommentLineId: new Map(),
      additions: 0,
      deletions: 0,
    };
  }

  const files = parsedDiff.files.map<NativeReviewDiffFile>((file) => ({
    id: file.id,
    path: file.path,
    language: getLanguageForPath(file.path, file.languageHint),
    additions: file.additions,
    deletions: file.deletions,
  }));
  const commentTargetsByRowId = new Map<string, NativeReviewDiffCommentTarget>();
  const rowIdByCommentLineId = new Map<string, string>();
  const rows = addNativeWordDiffRanges(
    Arr.flatMap(parsedDiff.files, (file) =>
      mapFileRows(file, comments, commentTargetsByRowId, rowIdByCommentLineId),
    ),
  );

  return {
    rows,
    files,
    commentTargetsByRowId,
    rowIdByCommentLineId,
    additions: parsedDiff.additions,
    deletions: parsedDiff.deletions,
  };
}

/**
 * Reuses the expensive flattened native row model across React development
 * render probes and unrelated draft updates. Only the latest comment version
 * is retained for each parsed diff so editing a comment cannot grow the cache.
 */
export function getCachedNativeReviewDiffData(
  input: BuildNativeReviewDiffDataInput,
): NativeReviewDiffData {
  const comments = input.comments ?? [];
  const commentsKey = buildReviewCommentsCacheKey(comments);
  const cached = nativeReviewDiffDataCache.get(input.parsedDiff);
  if (cached?.commentsKey === commentsKey) {
    return cached.data;
  }

  const data = buildNativeReviewDiffData({
    parsedDiff: input.parsedDiff,
    comments,
  });
  nativeReviewDiffDataCache.set(input.parsedDiff, { commentsKey, data });
  return data;
}
