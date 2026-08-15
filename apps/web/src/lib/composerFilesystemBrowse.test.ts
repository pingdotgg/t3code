import { describe, expect, it } from "vite-plus/test";

import {
  canBrowseComposerFilesystemPath,
  composerFilesystemSuggestionPath,
  isComposerFilesystemPathQuery,
} from "./composerFilesystemBrowse";

describe("composer filesystem browsing", () => {
  it.each([
    ["~/Sites/t3", "t3code", "~/Sites/t3code"],
    ["../sha", "shared", "../shared"],
    ["/tmp/rep", "report.md", "/tmp/report.md"],
    ["/Users/me/My Project/fi", "file.ts", "/Users/me/My Project/file.ts"],
    ["C:\\Users\\ch", "chris", "C:\\Users\\chris"],
  ])("preserves the typed parent for %s", (query, name, expected) => {
    expect(composerFilesystemSuggestionPath(query, name)).toBe(expected);
  });

  it("routes explicit paths according to platform and cwd", () => {
    expect(isComposerFilesystemPathQuery("./src", "linux")).toBe(true);
    expect(canBrowseComposerFilesystemPath("~/src", null, "linux")).toBe(true);
    expect(canBrowseComposerFilesystemPath("/tmp", null, "linux")).toBe(true);
    expect(canBrowseComposerFilesystemPath("./src", null, "linux")).toBe(false);
    expect(canBrowseComposerFilesystemPath("../src", "/repo", "linux")).toBe(true);
    expect(canBrowseComposerFilesystemPath("C:\\Users\\ch", null, "linux")).toBe(false);
    expect(canBrowseComposerFilesystemPath("C:\\Users\\ch", null, "win32")).toBe(true);
    expect(canBrowseComposerFilesystemPath("component", "/repo", "linux")).toBe(false);
  });
});
