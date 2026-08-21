import { describe, expect, it } from "vite-plus/test";

import { formatDroppedFilePaths, quoteDroppedFilePath } from "./droppedFilePaths";

describe("quoteDroppedFilePath", () => {
  it("leaves a path without whitespace alone", () => {
    expect(quoteDroppedFilePath("/Users/me/notes.pdf")).toBe("/Users/me/notes.pdf");
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

  it("skips empty and whitespace-only entries", () => {
    expect(formatDroppedFilePaths(["", "   ", "/a/one.opus"])).toBe("/a/one.opus");
  });

  it("returns an empty string when nothing resolved", () => {
    expect(formatDroppedFilePaths([])).toBe("");
  });
});
