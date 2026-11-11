import type { XcodeMark } from "@t3tools/shared/xcodeMarks";
import type {
  NativeReviewDiffRow,
  NativeReviewDiffStyle,
  NativeReviewDiffToken,
} from "../diffs/nativeReviewDiffSurface";
import type { ResolvedMobileCodeSurface } from "../../lib/appearancePreferences";
import { MOBILE_CODE_SURFACE, MOBILE_TYPOGRAPHY } from "../../lib/typography";
import type { HighlightedLines } from "../../lib/highlights";

export const NATIVE_SOURCE_CONTENT_WIDTH = 32_000;

export function createNativeSourceStyle(
  codeSurface: ResolvedMobileCodeSurface,
): NativeReviewDiffStyle {
  return {
    rowHeight: codeSurface.rowHeight,
    contentWidth: NATIVE_SOURCE_CONTENT_WIDTH,
    changeBarWidth: 0,
    gutterWidth: codeSurface.gutterWidth,
    codePadding: codeSurface.codePadding,
    textVerticalInset: codeSurface.textVerticalInset,
    codeFontSize: codeSurface.fontSize,
    codeFontWeight: "regular",
    lineNumberFontSize: codeSurface.lineNumberFontSize,
    lineNumberFontWeight: "regular",
    emptyStateFontSize: Math.round(
      MOBILE_TYPOGRAPHY.label.fontSize * (codeSurface.fontSize / MOBILE_CODE_SURFACE.fontSize),
    ),
    emptyStateFontWeight: "medium",
  };
}

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

function xcodeMarkTokenColor(kind: XcodeMark["kind"], scheme: "light" | "dark"): string {
  switch (kind) {
    case "todo":
      return scheme === "dark" ? "#E8B84A" : "#B45309";
    case "fixme":
      return scheme === "dark" ? "#F07178" : "#BE123C";
    default:
      return scheme === "dark" ? "#A3B1BF" : "#5A6470";
  }
}

export function buildNativeSourceTokens(
  tokenLines: HighlightedLines | null,
  options?: {
    readonly marksByLine?: ReadonlyMap<number, XcodeMark>;
    readonly colorScheme?: "light" | "dark";
    readonly lines?: ReadonlyArray<string>;
  },
): Readonly<Record<string, ReadonlyArray<NativeReviewDiffToken>>> {
  const marksByLine = options?.marksByLine;
  const colorScheme = options?.colorScheme ?? "dark";
  const lines = options?.lines;

  if (tokenLines === null) {
    if (!marksByLine || marksByLine.size === 0 || !lines) {
      return {};
    }
    return Object.fromEntries(
      [...marksByLine.entries()].map(([index, mark]) => [
        nativeSourceRowId(index),
        [
          {
            content: expandTabs(lines[index] ?? ""),
            color: xcodeMarkTokenColor(mark.kind, colorScheme),
            fontStyle: 2,
          },
        ],
      ]),
    );
  }

  return Object.fromEntries(
    tokenLines.map((tokens, index) => {
      const mark = marksByLine?.get(index);
      const markColor = mark ? xcodeMarkTokenColor(mark.kind, colorScheme) : null;
      return [
        nativeSourceRowId(index),
        tokens.map((token) => ({
          content: expandTabs(token.content),
          color: markColor ?? token.color,
          // Bit 2 is bold in the native review-diff token style flags.
          fontStyle: markColor != null ? (token.fontStyle ?? 0) | 2 : token.fontStyle,
        })),
      ];
    }),
  );
}
