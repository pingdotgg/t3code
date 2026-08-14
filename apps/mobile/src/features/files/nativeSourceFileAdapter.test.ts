import { describe, expect, it } from "vite-plus/test";

import {
  buildNativeSourceRows,
  buildNativeSourceTokens,
  createNativeSourceFileTheme,
  NATIVE_SOURCE_ROW_HEIGHT,
  NATIVE_SOURCE_STYLE,
  nativeSourceRowId,
} from "./nativeSourceFileAdapter";
import {
  NATIVE_REVIEW_DIFF_ROW_HEIGHT,
  NATIVE_REVIEW_DIFF_STYLE,
} from "../review/nativeReviewDiffAdapter";

describe("nativeSourceFileAdapter", () => {
  it("keeps the default native source theme byte-for-byte stable", () => {
    expect(createNativeSourceFileTheme("light")).toEqual({
      background: "#f2f2f7",
      text: "#070707",
      mutedText: "#8E8E95",
      headerBackground: "#f2f2f7",
      border: "#eeeeef",
      hunkBackground: "#e0f2ff",
      hunkText: "#009fff",
      addBackground: "#e5f8f5",
      deleteBackground: "#ffe6e7",
      addBar: "#00cab1",
      deleteBar: "#ff2e3f",
      addText: "#199F43",
      deleteText: "#D52C36",
    });
    expect(createNativeSourceFileTheme("dark")).toEqual({
      background: "#0e0e0e",
      text: "#adadb1",
      mutedText: "#8E8E95",
      headerBackground: "#0e0e0e",
      border: "#2e2e30",
      hunkBackground: "#071f28",
      hunkText: "#009fff",
      addBackground: "#0d2f28",
      deleteBackground: "#391415",
      addBar: "#00cab1",
      deleteBar: "#ff2e3f",
      addText: "#5ECC71",
      deleteText: "#FF6762",
    });
  });

  it("passes themed native source roles through without changing syntax tokens", () => {
    expect(
      createNativeSourceFileTheme("light", {
        sheetBackground: "#eef4fa",
        foreground: "#102030",
        mutedForeground: "#607080",
        border: "#ccddee",
        accent: "#2277cc",
      }),
    ).toMatchObject({
      background: "#eef4fa",
      text: "#102030",
      mutedText: "#607080",
      headerBackground: "#eef4fa",
      border: "#ccddee",
      hunkText: "#2277cc",
    });
  });

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
