import { describe, expect, it } from "vite-plus/test";

import { findComposerLinks } from "./composer-links";

function linkTexts(text: string): string[] {
  return findComposerLinks(text).map(({ from, to }) => text.slice(from, to));
}

describe("findComposerLinks", () => {
  it("finds http(s) URLs with their host", () => {
    const url = "https://github.com/pingdotgg/t3code/pull/22426#pullrequestreview-1";
    expect(findComposerLinks(`see ${url} now`)).toEqual([
      { from: 4, to: 4 + url.length, host: "github.com" },
    ]);
  });

  it("drops trailing punctuation and unbalanced closing parens", () => {
    expect(
      linkTexts("(https://example.com/a), https://example.com/b. [x](https://example.com/c)"),
    ).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
    expect(linkTexts("https://en.wikipedia.org/wiki/Foo_(bar)!")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("drops entity-like suffixes whole, as GFM does", () => {
    expect(
      linkTexts(
        "https://example.com?q=x&hl; https://example.com/a.&hl;&gt; https://example.com/b&1; https://example.com/c&;",
      ),
    ).toEqual([
      "https://example.com?q=x",
      "https://example.com/a",
      "https://example.com/b&1",
      "https://example.com/c&",
    ]);
  });

  it("matches GFM's boundaries and keeps quotes inside the path", () => {
    expect(
      linkTexts('[https://github.com] 1https://example.com/a\'b "https://example.com/c"'),
    ).toEqual(["https://github.com", "https://example.com/a'b", "https://example.com/c"]);
  });

  it("ignores URLs glued to a letter or without a host", () => {
    expect(linkTexts("xhttps://example.com https:// ftp://example.com")).toEqual([]);
  });

  it("trims a long run of closing parens in linear time", () => {
    const parens = ")".repeat(200_000);
    expect(linkTexts(`https://example.com${parens}`)).toEqual(["https://example.com"]);
  });
});
