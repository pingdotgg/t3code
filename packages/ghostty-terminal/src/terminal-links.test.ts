import { describe, expect, it } from "vite-plus/test";
import { extractTerminalLinks } from "./terminal-links.js";

describe("terminal link punctuation", () => {
  it("drops the separator colon after a compiler path and its line and column", () => {
    const links = extractTerminalLinks("/tmp/source.ts:12:4: error");
    expect(links.map((link) => link.text)).toEqual(["/tmp/source.ts:12:4"]);
  });

  it("preserves a trailing colon in a URL", () => {
    const links = extractTerminalLinks("https://example.com/path:");
    expect(links.map((link) => link.text)).toEqual(["https://example.com/path:"]);
  });
});
