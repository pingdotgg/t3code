import { describe, expect, it } from "vite-plus/test";

import { clipboardHasText } from "./composerClipboard";

function clipboardData(text: string, types: string[]): Pick<DataTransfer, "getData" | "types"> {
  return {
    getData: () => text,
    types,
  };
}

describe("clipboardHasText", () => {
  it("keeps text from a clipboard payload that also contains files", () => {
    expect(
      clipboardHasText(clipboardData("copied from a spreadsheet", ["Files", "text/plain"])),
    ).toBe(true);
  });

  it("recognizes rich text even when plain text is empty", () => {
    expect(clipboardHasText(clipboardData("", ["Files", "text/html"]))).toBe(true);
  });

  it("returns false for a file-only clipboard payload", () => {
    expect(clipboardHasText(clipboardData("", ["Files"]))).toBe(false);
  });
});
