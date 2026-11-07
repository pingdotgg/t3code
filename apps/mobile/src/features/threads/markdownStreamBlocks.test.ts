import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownBlocks } from "./markdownStreamBlocks";

describe("splitMarkdownBlocks", () => {
  it.each([
    "# Title\n\nFirst paragraph.\n\nSecond paragraph.",
    "- one\n- two\n\nAfter the list.",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter",
  ])("joins back to the source at every prefix: %j", (text) => {
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source);
      expect(blocks?.join("")).toBe(source);
    }
  });

  it("returns null for document-wide syntax", () => {
    expect(splitMarkdownBlocks("[id]: https://example.com\n\npara")).toBeNull();
    expect(splitMarkdownBlocks("$$\nx\n$$\n\npara")).toBeNull();
  });
});
