import type { NativeReviewDiffRow, NativeReviewDiffTheme } from "../diffs/nativeReviewDiffSurface";
import type {
  NativeReviewDiffFile,
  NativeReviewDiffLanguage,
} from "../diffs/nativeReviewDiffTypes";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import type { ResolvedMobileCodeSurface } from "../../lib/appearancePreferences";
import { type MobileThemeId, type MobileThemeVariables } from "../../lib/mobileTheme";
import { getMobileTerminalTheme, type TerminalAppearanceScheme } from "../terminal/terminalTheme";
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
const NATIVE_HEX_COLOR = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;
const NATIVE_RGBA_COLOR =
  /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/;

export const NATIVE_REVIEW_DIFF_CONTENT_WIDTH = 2_800;

function opaqueNativeHexColor(color: string, background: string): string {
  const hex = NATIVE_HEX_COLOR.exec(color);
  if (hex) return color;

  const rgba = NATIVE_RGBA_COLOR.exec(color);
  const backgroundHex = NATIVE_HEX_COLOR.exec(background);
  if (!rgba || !backgroundHex) return background;

  const alpha = rgba[4] === undefined ? 1 : Math.min(1, Math.max(0, Number(rgba[4])));
  const channels = [1, 2, 3].map((index) => {
    const foreground = Number(rgba[index]);
    const behind = Number.parseInt(backgroundHex[index], 16);
    return Math.round(foreground * alpha + behind * (1 - alpha));
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

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
  readonly prepared: PreparedNativeReviewDiffData;
  readonly commentsKey: string;
  readonly data: NativeReviewDiffData;
}

interface PreparedNativeReviewFileRows {
  readonly fileId: string;
  readonly filePath: string;
  readonly lineCount: number;
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  commentedRows: {
    readonly commentsKey: string;
    readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  } | null;
}

interface PreparedNativeReviewDiffData extends Omit<NativeReviewDiffData, "rows"> {
  readonly fileRows: ReadonlyArray<PreparedNativeReviewFileRows>;
}

const nativeReviewDiffDataCache = new WeakMap<ReviewParsedDiff, CachedNativeReviewDiffData>();

function buildReviewCommentsCacheKey(comments: ReadonlyArray<ReviewInlineComment>): string {
  if (comments.length === 0) {
    return "none";
  }

  return JSON.stringify(
    comments.map((comment) => [
      comment.id,
      comment.sectionId,
      comment.sectionTitle,
      comment.filePath,
      comment.startIndex,
      comment.endIndex,
      comment.rangeLabel,
      comment.text,
    ]),
  );
}

export function createNativeReviewDiffTheme(
  scheme: TerminalAppearanceScheme,
  themeId: MobileThemeId,
  appTheme: MobileThemeVariables,
): NativeReviewDiffTheme {
  const terminalTheme = getMobileTerminalTheme(themeId, scheme);
  const [, terminalRed] = terminalTheme.palette;
  // Swift expects #RRGGBB/#RRGGBBAA while Android expects #RRGGBB/#AARRGGBB.
  // Flatten translucent app tokens onto the code surface so both native
  // implementations receive the one unambiguous shared format.
  const background = opaqueNativeHexColor(appTheme["--color-sheet"], appTheme["--color-screen"]);
  const nativeColor = (color: string) => opaqueNativeHexColor(color, background);

  if (scheme === "dark") {
    return {
      // Match the app surface (--color-sheet) so code views blend with the rest of
      // the app instead of using a distinct code-editor background.
      background,
      text: nativeColor(appTheme["--color-md-code-text"]),
      mutedText: nativeColor(appTheme["--color-foreground-muted"]),
      headerBackground: background,
      border: nativeColor(appTheme["--color-border"]),
      hunkBackground: nativeColor(appTheme["--color-subtle-strong"]),
      hunkText: nativeColor(appTheme["--color-primary"]),
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
    background,
    text: nativeColor(appTheme["--color-md-code-text"]),
    mutedText: nativeColor(appTheme["--color-foreground-muted"]),
    headerBackground: background,
    border: nativeColor(appTheme["--color-border"]),
    hunkBackground: nativeColor(appTheme["--color-subtle-strong"]),
    hunkText: nativeColor(appTheme["--color-primary"]),
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

function prepareFileRows(
  file: ReviewRenderableFile,
  commentTargetsByRowId: Map<string, NativeReviewDiffCommentTarget>,
  rowIdByCommentLineId: Map<string, string>,
): PreparedNativeReviewFileRows {
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
    lineIndex += 1;
  });

  rows.push(...noticeRowsForFile(file));
  return {
    fileId: file.id,
    filePath: file.path,
    lineCount: lineRows.length,
    // Comments must not split the source deletion/addition runs used for word matching.
    rows: addNativeWordDiffRanges(rows),
    commentedRows: null,
  };
}

function insertFileComments(
  file: PreparedNativeReviewFileRows,
  comments: ReadonlyArray<ReviewInlineComment>,
): ReadonlyArray<NativeReviewDiffRow> {
  if (comments.length === 0) {
    file.commentedRows = null;
    return file.rows;
  }
  const commentsKey = buildReviewCommentsCacheKey(comments);
  if (file.commentedRows?.commentsKey === commentsKey) {
    return file.commentedRows.rows;
  }

  const commentsByEndIndex = new Map<number, ReviewInlineComment[]>();
  for (const comment of comments) {
    const endIndex = Math.min(comment.endIndex, file.lineCount - 1);
    if (endIndex < 0) continue;
    const existing = commentsByEndIndex.get(endIndex);
    if (existing) {
      existing.push(comment);
    } else {
      commentsByEndIndex.set(endIndex, [comment]);
    }
  }
  const rows: NativeReviewDiffRow[] = [];
  let lineIndex = 0;
  for (const row of file.rows) {
    rows.push(row);
    if (row.kind !== "line") continue;
    for (const comment of commentsByEndIndex.get(lineIndex) ?? []) {
      rows.push({
        kind: "comment",
        id: comment.id,
        fileId: file.fileId,
        filePath: file.filePath,
        commentText: comment.text,
        commentRangeLabel: comment.rangeLabel,
        commentSectionTitle: comment.sectionTitle,
      });
    }
    lineIndex += 1;
  }
  file.commentedRows = { commentsKey, rows };
  return rows;
}

function prepareNativeReviewDiffData(parsedDiff: ReviewParsedDiff): PreparedNativeReviewDiffData {
  if (parsedDiff.kind !== "files") {
    return {
      fileRows: [],
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
  const fileRows = parsedDiff.files.map((file) =>
    prepareFileRows(file, commentTargetsByRowId, rowIdByCommentLineId),
  );

  return {
    fileRows,
    files,
    commentTargetsByRowId,
    rowIdByCommentLineId,
    additions: parsedDiff.additions,
    deletions: parsedDiff.deletions,
  };
}

function buildCommentedNativeReviewDiffData(
  prepared: PreparedNativeReviewDiffData,
  comments: ReadonlyArray<ReviewInlineComment>,
): NativeReviewDiffData {
  const commentsByFilePath = new Map<string, ReviewInlineComment[]>();
  for (const comment of comments) {
    const existing = commentsByFilePath.get(comment.filePath);
    if (existing) {
      existing.push(comment);
    } else {
      commentsByFilePath.set(comment.filePath, [comment]);
    }
  }
  return {
    rows: Arr.flatMap(prepared.fileRows, (file) =>
      insertFileComments(file, commentsByFilePath.get(file.filePath) ?? []),
    ),
    files: prepared.files,
    commentTargetsByRowId: prepared.commentTargetsByRowId,
    rowIdByCommentLineId: prepared.rowIdByCommentLineId,
    additions: prepared.additions,
    deletions: prepared.deletions,
  };
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
  return buildCommentedNativeReviewDiffData(prepareNativeReviewDiffData(parsedDiff), comments);
}

/**
 * Prepares source rows once per parsed diff, including its section-specific IDs.
 * Comment edits reuse those rows, word ranges, and targets. Each file retains
 * only its latest comment overlay, and the weak key releases old parsed diffs.
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

  const prepared = cached?.prepared ?? prepareNativeReviewDiffData(input.parsedDiff);
  const data = buildCommentedNativeReviewDiffData(prepared, comments);
  nativeReviewDiffDataCache.set(input.parsedDiff, { prepared, commentsKey, data });
  return data;
}
