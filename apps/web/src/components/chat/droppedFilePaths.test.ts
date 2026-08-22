import { describe, expect, it } from "vite-plus/test";

import { formatDroppedFilePaths, quoteDroppedFilePath } from "./droppedFilePaths";

describe("quoteDroppedFilePath", () => {
  it("leaves a path without whitespace alone", () => {
    expect(quoteDroppedFilePath("/Users/me/notes.pdf")).toBe("/Users/me/notes.pdf");
  });

  it("escapes a double quote inside a quoted path", () => {
    expect(quoteDroppedFilePath('/tmp/a " b.pdf')).toBe('"/tmp/a \\" b.pdf"');
  });

  it("leaves a double quote alone when there is no whitespace to quote for", () => {
    expect(quoteDroppedFilePath('/tmp/a"b.pdf')).toBe('/tmp/a"b.pdf');
  });

  it("quotes a path containing spaces", () => {
    expect(quoteDroppedFilePath("/Users/me/Voice Memos/note 1.m4a")).toBe(
      '"/Users/me/Voice Memos/note 1.m4a"',
    );
  });
});

describe("formatDroppedFilePaths", () => {
  it("joins several paths with a space", () => {
    expect(formatDroppedFilePaths(["/a/one.opus", "/b/two.pdf"])).toBe("/a/one.opus /b/two.pdf");
  });

  it("preserves a trailing space in a filename instead of trimming it", () => {
    expect(formatDroppedFilePaths(["/tmp/report "])).toBe('"/tmp/report "');
  });

  it("skips empty and whitespace-only entries", () => {
    expect(formatDroppedFilePaths(["", "   ", "/a/one.opus"])).toBe("/a/one.opus");
  });

  it("returns an empty string when nothing resolved", () => {
    expect(formatDroppedFilePaths([])).toBe("");
  });
});
