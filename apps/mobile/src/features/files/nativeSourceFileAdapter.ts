import type {
  NativeReviewDiffRow,
  NativeReviewDiffStyle,
  NativeReviewDiffToken,
} from "../diffs/nativeReviewDiffSurface";
import type { SourceHighlightTokens } from "./sourceHighlightingState";

export const NATIVE_SOURCE_ROW_HEIGHT = 24;
export const NATIVE_SOURCE_CONTENT_WIDTH = 32_000;

export const NATIVE_SOURCE_STYLE: NativeReviewDiffStyle = {
  rowHeight: NATIVE_SOURCE_ROW_HEIGHT,
  contentWidth: NATIVE_SOURCE_CONTENT_WIDTH,
  changeBarWidth: 0,
  gutterWidth: 58,
  codePadding: 8,
  codeFontSize: 13,
  codeFontWeight: "medium",
  lineNumberFontSize: 11,
  lineNumberFontWeight: "medium",
  emptyStateFontSize: 12,
  emptyStateFontWeight: "medium",
};

const SOURCE_FILE_ID = "source-file";

function expandTabs(value: string): string {
  return value.replace(/\t/g, "    ");
}

export function nativeSourceRowId(index: number): string {
  return `source-line:${index}`;
}

export function buildNativeSourceRows(
  lines: ReadonlyArray<string>,
): ReadonlyArray<NativeReviewDiffRow> {
  return lines.map((line, index) => ({
    kind: "line",
    id: nativeSourceRowId(index),
    fileId: SOURCE_FILE_ID,
    content: expandTabs(line),
    change: "context",
    newLineNumber: index + 1,
  }));
}

export function buildNativeSourceTokens(
  tokenLines: SourceHighlightTokens | null,
): Readonly<Record<string, ReadonlyArray<NativeReviewDiffToken>>> {
  if (tokenLines === null) {
    return {};
  }

  return Object.fromEntries(
    tokenLines.map((tokens, index) => [
      nativeSourceRowId(index),
      tokens.map((token) => ({
        content: expandTabs(token.content),
        color: token.color,
        fontStyle: token.fontStyle,
      })),
    ]),
  );
}
