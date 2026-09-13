import { describe, expect, it } from "vite-plus/test";

import {
  markdownRoundTrip,
  markdownSupportsInPlaceEditing,
  withTrailingNewlineFrom,
} from "./markdownInPlaceEditing";

describe("markdownSupportsInPlaceEditing", () => {
  it("edits a document the editor reproduces exactly", () => {
    const text = [
      "# Release notes",
      "",
      "## Fixed",
      "",
      "- [x] Saving a file no longer drops its last line",
      "- [ ] Restore the diff gutter",
      "",
      "> Ship it.",
      "",
      "```ts",
      'const greeting = "hello";',
      "```",
      "",
      "See [the docs](https://t3.gg) for the rest.",
      "",
      "---",
      "",
      "Thanks for reading.",
      "",
    ].join("\n");

    expect(markdownRoundTrip(text)).toBe(text.replace(/\n+$/, ""));
    expect(markdownSupportsInPlaceEditing(text)).toBe(true);
  });

  it.each([
    ["a nested list", "- outer\n  - inner\n- outer two\n"],
    ["front matter", "---\ntitle: Plans\n---\n\nBody.\n"],
    ["a tilde fence", "~~~ts\nconst a = 1;\n~~~\n"],
    ["a fence inside a list", "- item\n\n  ```ts\n  const a = 1;\n  ```\n"],
    ["hard line breaks", "line one  \nline two\n"],
    ["repeated ordered markers", "1. first\n1. second\n"],
    ["escaped emphasis characters", "file_name_here\n"],
    ["CRLF line endings", "# Title\r\n\r\nBody.\r\n"],
  ])("leaves %s to the preview, because saving would rewrite it", (_name, text) => {
    expect(markdownRoundTrip(text)).not.toBe(text.replace(/\n+$/, ""));
    expect(markdownSupportsInPlaceEditing(text)).toBe(false);
  });

  it("leaves a long file to the preview rather than parsing it on open", () => {
    const paragraph = "Ordinary prose about the change and why it matters.\n\n";
    const long = paragraph.repeat(Math.ceil((64 * 1024) / paragraph.length) + 1);

    expect(markdownRoundTrip(long)).toBe(long.replace(/\n+$/, ""));
    expect(markdownSupportsInPlaceEditing(long)).toBe(false);
  });

  it.each([
    ["a table", "| Surface | Ships |\n| --- | --- |\n| web | yes |\n"],
    ["an image", "![diagram](./diagram.png)\n"],
    ["raw HTML", "<details>\n<summary>More</summary>\n</details>\n"],
  ])("leaves %s to the preview, because the editor shows it as source", (_name, text) => {
    expect(markdownSupportsInPlaceEditing(text)).toBe(false);
  });
});

describe("withTrailingNewlineFrom", () => {
  it("keeps the newline the file ended with", () => {
    expect(withTrailingNewlineFrom("# Title\n", "# Title edited")).toBe("# Title edited\n");
    expect(withTrailingNewlineFrom("# Title", "# Title edited")).toBe("# Title edited");
    expect(withTrailingNewlineFrom("# Title\n\n", "# Title edited")).toBe("# Title edited\n\n");
  });
});
