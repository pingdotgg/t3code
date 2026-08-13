import type {
  NativeReviewDiffRow,
  NativeReviewDiffStyle,
  NativeReviewDiffToken,
} from "../diffs/nativeReviewDiffSurface";
import type { ResolvedMobileCodeSurface } from "../../lib/appearancePreferences";
import { resolveMobileCodeSurface } from "../../lib/appearancePreferences";
import { MOBILE_CODE_SURFACE, MOBILE_TYPOGRAPHY } from "../../lib/typography";
import type { SourceHighlightTokens } from "./sourceHighlightingState";

export const NATIVE_SOURCE_ROW_HEIGHT = MOBILE_CODE_SURFACE.rowHeight;
export const NATIVE_SOURCE_CONTENT_WIDTH = 32_000;

export const NATIVE_SOURCE_STYLE: NativeReviewDiffStyle = createNativeSourceStyle(
  resolveMobileCodeSurface(MOBILE_CODE_SURFACE.fontSize),
);

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

function expandedColumnCount(value: string): number {
  let columns = 0;
  for (const character of value) {
    columns += character === "\t" ? 4 : 1;
  }
  return columns;
}

function splitAtColumns(value: string, columns: number | null): ReadonlyArray<string> {
  const expanded = expandTabs(value);
  if (columns === null) {
    return [expanded];
  }

  const characters = Array.from(expanded);
  if (characters.length === 0) {
    return [""];
  }

  const segments: string[] = [];
  for (let offset = 0; offset < characters.length; offset += columns) {
    segments.push(characters.slice(offset, offset + columns).join(""));
  }
  return segments;
}

function normalizedWrapColumns(wrapColumns?: number): number | null {
  return typeof wrapColumns === "number" && Number.isFinite(wrapColumns)
    ? Math.max(1, Math.floor(wrapColumns))
    : null;
}

export function nativeSourceRowId(index: number, segment = 0): string {
  return segment === 0 ? `source-line:${index}` : `source-line:${index}:wrap:${segment}`;
}

export function nativeSourceRowCount(line: string, wrapColumns?: number): number {
  const columns = normalizedWrapColumns(wrapColumns);
  return columns === null ? 1 : Math.max(1, Math.ceil(expandedColumnCount(line) / columns));
}

export function nativeSourceRowIndexForLine(
  lines: ReadonlyArray<string>,
  lineIndex: number,
  wrapColumns?: number,
): number {
  const target = Math.max(0, Math.min(Math.floor(lineIndex), lines.length));
  let rowIndex = 0;
  for (let index = 0; index < target; index += 1) {
    rowIndex += nativeSourceRowCount(lines[index] ?? "", wrapColumns);
  }
  return rowIndex;
}

export function nativeSourceRowIdsForLine(
  line: string,
  lineIndex: number,
  wrapColumns?: number,
): ReadonlyArray<string> {
  return Array.from({ length: nativeSourceRowCount(line, wrapColumns) }, (_, segment) =>
    nativeSourceRowId(lineIndex, segment),
  );
}

export function nativeSourceWrapColumns(
  viewportWidth: number,
  codeSurface: ResolvedMobileCodeSurface,
): number {
  const availableWidth = viewportWidth - codeSurface.gutterWidth - codeSurface.codePadding * 2;
  // Both native canvases use the system monospace font. A conservative width
  // estimate keeps the final glyph inside the viewport on iOS and Android.
  return Math.max(1, Math.floor(availableWidth / (codeSurface.fontSize * 0.62)));
}

export function buildNativeSourceRows(
  lines: ReadonlyArray<string>,
  wrapColumns?: number,
): ReadonlyArray<NativeReviewDiffRow> {
  const columns = normalizedWrapColumns(wrapColumns);
  return lines.flatMap((line, index) =>
    splitAtColumns(line, columns).map((content, segment) => ({
      kind: "line" as const,
      id: nativeSourceRowId(index, segment),
      fileId: SOURCE_FILE_ID,
      content,
      change: "context" as const,
      newLineNumber: segment === 0 ? index + 1 : null,
    })),
  );
}

function splitTokensAtColumns(
  tokens: ReadonlyArray<NativeReviewDiffToken>,
  columns: number | null,
): ReadonlyArray<ReadonlyArray<NativeReviewDiffToken>> {
  if (columns === null) {
    return [tokens];
  }

  const segments: NativeReviewDiffToken[][] = [[]];
  let currentColumn = 0;
  for (const token of tokens) {
    const characters = Array.from(token.content);
    let offset = 0;
    while (offset < characters.length) {
      if (currentColumn === columns) {
        segments.push([]);
        currentColumn = 0;
      }
      const length = Math.min(columns - currentColumn, characters.length - offset);
      segments.at(-1)?.push({
        ...token,
        content: characters.slice(offset, offset + length).join(""),
      });
      offset += length;
      currentColumn += length;
    }
  }
  return segments;
}

export function buildNativeSourceTokens(
  tokenLines: SourceHighlightTokens | null,
  wrapColumns?: number,
): Readonly<Record<string, ReadonlyArray<NativeReviewDiffToken>>> {
  if (tokenLines === null) {
    return {};
  }

  const columns = normalizedWrapColumns(wrapColumns);
  return Object.fromEntries(
    tokenLines.flatMap((tokens, index) =>
      splitTokensAtColumns(
        tokens.map((token) => ({
          content: expandTabs(token.content),
          color: token.color,
          fontStyle: token.fontStyle,
        })),
        columns,
      ).map((segmentTokens, segment) => [nativeSourceRowId(index, segment), segmentTokens]),
    ),
  );
}
