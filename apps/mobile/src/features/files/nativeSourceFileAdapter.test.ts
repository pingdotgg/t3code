import { describe, expect, it } from "vite-plus/test";

import {
  buildNativeSourceRows,
  buildNativeSourceTokens,
  NATIVE_SOURCE_ROW_HEIGHT,
  NATIVE_SOURCE_STYLE,
  nativeSourceRowId,
  nativeSourceRowIdsForLine,
  nativeSourceRowIndexForLine,
  nativeSourceWrapColumns,
} from "./nativeSourceFileAdapter";
import { resolveMobileCodeSurface } from "../../lib/appearancePreferences";
import {
  NATIVE_REVIEW_DIFF_ROW_HEIGHT,
  NATIVE_REVIEW_DIFF_STYLE,
} from "../review/nativeReviewDiffAdapter";

describe("nativeSourceFileAdapter", () => {
  it("uses the same compact code typography as the diff viewer", () => {
    expect(NATIVE_SOURCE_ROW_HEIGHT).toBe(NATIVE_REVIEW_DIFF_ROW_HEIGHT);
    expect(NATIVE_SOURCE_STYLE).toMatchObject({
      rowHeight: NATIVE_REVIEW_DIFF_STYLE.rowHeight,
      gutterWidth: NATIVE_REVIEW_DIFF_STYLE.gutterWidth,
      codePadding: NATIVE_REVIEW_DIFF_STYLE.codePadding,
      textVerticalInset: NATIVE_REVIEW_DIFF_STYLE.textVerticalInset,
      codeFontSize: NATIVE_REVIEW_DIFF_STYLE.codeFontSize,
      codeFontWeight: NATIVE_REVIEW_DIFF_STYLE.codeFontWeight,
      lineNumberFontSize: NATIVE_REVIEW_DIFF_STYLE.lineNumberFontSize,
      lineNumberFontWeight: NATIVE_REVIEW_DIFF_STYLE.lineNumberFontWeight,
    });
  });

  it("maps plain source lines onto context rows with stable line numbers", () => {
    expect(buildNativeSourceRows(["const value = 1;", "\treturn value;"])).toEqual([
      {
        kind: "line",
        id: nativeSourceRowId(0),
        fileId: "source-file",
        content: "const value = 1;",
        change: "context",
        newLineNumber: 1,
      },
      {
        kind: "line",
        id: nativeSourceRowId(1),
        fileId: "source-file",
        content: "    return value;",
        change: "context",
        newLineNumber: 2,
      },
    ]);
  });

  it("maps cached source tokens to the same row identifiers", () => {
    expect(
      buildNativeSourceTokens([
        [{ content: "const", color: "#ff0000", fontStyle: 2 }],
        [{ content: "\tvalue", color: null, fontStyle: null }],
      ]),
    ).toEqual({
      [nativeSourceRowId(0)]: [{ content: "const", color: "#ff0000", fontStyle: 2 }],
      [nativeSourceRowId(1)]: [{ content: "    value", color: null, fontStyle: null }],
    });
  });

  it("wraps source lines into native continuation rows", () => {
    expect(buildNativeSourceRows(["abcdefg", "xy"], 3)).toEqual([
      {
        kind: "line",
        id: nativeSourceRowId(0),
        fileId: "source-file",
        content: "abc",
        change: "context",
        newLineNumber: 1,
      },
      {
        kind: "line",
        id: nativeSourceRowId(0, 1),
        fileId: "source-file",
        content: "def",
        change: "context",
        newLineNumber: null,
      },
      {
        kind: "line",
        id: nativeSourceRowId(0, 2),
        fileId: "source-file",
        content: "g",
        change: "context",
        newLineNumber: null,
      },
      {
        kind: "line",
        id: nativeSourceRowId(1),
        fileId: "source-file",
        content: "xy",
        change: "context",
        newLineNumber: 2,
      },
    ]);
  });

  it("splits syntax tokens across the same native continuation rows", () => {
    expect(
      buildNativeSourceTokens(
        [
          [
            { content: "abc", color: "#ff0000", fontStyle: 2 },
            { content: "defg", color: "#00ff00", fontStyle: null },
          ],
        ],
        4,
      ),
    ).toEqual({
      [nativeSourceRowId(0)]: [
        { content: "abc", color: "#ff0000", fontStyle: 2 },
        { content: "d", color: "#00ff00", fontStyle: null },
      ],
      [nativeSourceRowId(0, 1)]: [{ content: "efg", color: "#00ff00", fontStyle: null }],
    });
  });

  it("maps source-line navigation onto wrapped native rows", () => {
    const lines = ["12345", "x", "abcdef"];
    expect(nativeSourceRowIndexForLine(lines, 2, 3)).toBe(3);
    expect(nativeSourceRowIdsForLine(lines[2] ?? "", 2, 3)).toEqual([
      nativeSourceRowId(2),
      nativeSourceRowId(2, 1),
    ]);
  });

  it("derives conservative wrap columns from the native code geometry", () => {
    expect(nativeSourceWrapColumns(390, resolveMobileCodeSurface(12))).toBe(44);
  });

  it("clears native tokens while highlighting is unavailable", () => {
    expect(buildNativeSourceTokens(null)).toEqual({});
  });
});
