import { describe, expect, it } from "vite-plus/test";

import { splitLargeMarkdown } from "./markdownChunks.ts";

const starts = (text: string) =>
  splitLargeMarkdown(text, 1).map((chunk) => chunk.text.split("\n")[0]);

describe("splitLargeMarkdown", () => {
  it("cuts only where a new top-level block starts, and keeps every byte", () => {
    const text = [
      "# Title",
      "Intro paragraph",
      "",
      "- item one",
      "",
      "  continued item",
      "- item two",
      "",
      "2. ordered",
      "",
      "```md",
      "# not a heading",
      "",
      "Not a paragraph",
      "```",
      "",
      "> quote",
      "",
      "Closing paragraph",
      "## Next",
      "---",
      "",
      "| a | b |",
    ].join("\n");
    const chunks = splitLargeMarkdown(text, 1);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(text);
    expect(chunks.reduce((sum, chunk) => sum + chunk.lines, 0)).toBe(text.split("\n").length);
    expect(starts(text)).toEqual([
      "# Title",
      "```md",
      "> quote",
      "Closing paragraph",
      "## Next",
      "| a | b |",
    ]);
  });

  it("keeps a fence open until a matching closer", () => {
    const text = ["````", "```", "", "# inside", "````", "", "after"].join("\n");
    expect(starts(text)).toEqual(["````", "after"]);
  });

  it("keeps HTML blocks and display math open across blank lines", () => {
    const text = [
      "<!--",
      "",
      "# hidden",
      "-->",
      "",
      "$$",
      "",
      "Inside math",
      "$$",
      "",
      "<pre>",
      "",
      "Preformatted",
      "</pre>",
      "",
      "<!-- one line -->",
      "",
      "<div>",
      "# literal",
      "</div>",
      "",
      "after",
    ].join("\n");
    expect(starts(text)).toEqual(["<!--", "after"]);
  });

  it("still cuts after an autolink line", () => {
    const text = ["<https://example.com>", "# next"].join("\n");
    expect(starts(text)).toEqual(["<https://example.com>", "# next"]);
  });

  it("waits for the target size before cutting", () => {
    const text = ["# a", "", "b", "", "# c", "", "d"].join("\n");
    expect(splitLargeMarkdown(text, 6).map((chunk) => chunk.text)).toEqual([
      "# a\n\nb\n",
      "# c\n\nd",
    ]);
  });
});
