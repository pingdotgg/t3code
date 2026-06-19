import type {
  NativeReviewDiffRow,
  NativeReviewDiffStyle,
  NativeReviewDiffToken,
} from "../diffs/nativeReviewDiffSurface";
import { MOBILE_CODE_SURFACE, MOBILE_TYPOGRAPHY } from "../../lib/typography";
import type { SourceHighlightTokens } from "./sourceHighlightingState";

export const NATIVE_SOURCE_ROW_HEIGHT = MOBILE_CODE_SURFACE.rowHeight;
export const NATIVE_SOURCE_CONTENT_WIDTH = 32_000;

export const NATIVE_SOURCE_STYLE: NativeReviewDiffStyle = {
  rowHeight: NATIVE_SOURCE_ROW_HEIGHT,
  contentWidth: NATIVE_SOURCE_CONTENT_WIDTH,
  changeBarWidth: 0,
  gutterWidth: MOBILE_CODE_SURFACE.gutterWidth,
  codePadding: MOBILE_CODE_SURFACE.codePadding,
  textVerticalInset: MOBILE_CODE_SURFACE.textVerticalInset,
  codeFontSize: MOBILE_CODE_SURFACE.fontSize,
  codeFontWeight: "regular",
  lineNumberFontSize: MOBILE_CODE_SURFACE.lineNumberFontSize,
  lineNumberFontWeight: "regular",
  emptyStateFontSize: MOBILE_TYPOGRAPHY.label.fontSize,
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
