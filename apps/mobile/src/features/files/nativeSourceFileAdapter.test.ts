import { describe, expect, it } from "vite-plus/test";

import {
  buildNativeSourceRows,
  buildNativeSourceTokens,
  NATIVE_SOURCE_ROW_HEIGHT,
  NATIVE_SOURCE_STYLE,
  nativeSourceRowId,
} from "./nativeSourceFileAdapter";
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

  it("clears native tokens while highlighting is unavailable", () => {
    expect(buildNativeSourceTokens(null)).toEqual({});
  });
});
