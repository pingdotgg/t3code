import { describe, expect, it } from "vitest";

import {
  hasAssistantResponseCopyText,
  markdownToPlainText,
  resolveAssistantMessageCopyText,
} from "./assistantMessageCopy";

describe("assistantMessageCopy", () => {
  it("returns the raw assistant markdown unchanged in markdown mode", () => {
    const markdown = ["# Heading", "", "- item", "", "```ts", "console.log('hi');", "```"].join(
      "\n",
    );

    expect(resolveAssistantMessageCopyText(markdown, "markdown")).toBe(markdown);
  });

  it("serializes markdown into stable plain text", () => {
    const markdown = [
      "# Heading",
      "",
      "Paragraph with [docs](https://example.com/docs) and [](https://example.com/fallback).",
      "",
      "> Quoted **text**",
      "",
      "- first item",
      "- second item",
      "",
      "1. ordered",
      "2. next",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| One | 1 |",
      "",
      "```ts",
      "const value = 1;",
      "console.log(value);",
      "```",
    ].join("\n");

    expect(markdownToPlainText(markdown)).toBe(
      [
        "Heading",
        "",
        "Paragraph with docs and https://example.com/fallback.",
        "",
        "Quoted text",
        "",
        "- first item",
        "- second item",
        "",
        "1. ordered",
        "2. next",
        "",
        "Name | Value",
        "One | 1",
        "",
        "const value = 1;",
        "console.log(value);",
      ].join("\n"),
    );
  });

  it("aligns continuation blocks for ordered lists with wide markers", () => {
    const markdown = [
      "10. first paragraph",
      "",
      "    ```ts",
      "    const value = 1;",
      "    ```",
    ].join("\n");

    expect(markdownToPlainText(markdown)).toBe(
      ["10. first paragraph", "    const value = 1;"].join("\n"),
    );
  });

  it("preserves gfm task state in copied plain text", () => {
    const markdown = ["- [x] done", "- [ ] todo", "", "1. [x] ship it"].join("\n");

    expect(markdownToPlainText(markdown)).toBe(
      ["- [x] done", "- [ ] todo", "", "1. [x] ship it"].join("\n"),
    );
  });

  it("preserves visible raw html text in plain-text mode", () => {
    const markdown = ["<details>", "<summary>Example</summary>", "</details>"].join("\n");

    expect(markdownToPlainText(markdown)).toBe(markdown);
    expect(hasAssistantResponseCopyText(markdown, "plain-text")).toBe(true);
  });

  it("preserves leading indentation for top-level code blocks", () => {
    const markdown = ["```py", "  print('hi')", "```"].join("\n");

    expect(markdownToPlainText(markdown)).toBe("  print('hi')");
  });

  it("collapses soft-wrapped paragraph newlines but preserves explicit breaks", () => {
    const markdown = ["soft", "wrap", "", "hard  ", "break"].join("\n");

    expect(markdownToPlainText(markdown)).toBe(["soft wrap", "", "hard", "break"].join("\n"));
  });
});
