import { describe, expect, it } from "@effect/vitest";

import { adfToMarkdown, hasUnwritableContent, markdownToAdf } from "./adf.ts";

const MARKDOWN = [
  "# Crash on launch",
  "Opens **then** *dies* with `EPIPE`, see [the log](https://logs.test/1).",
  "- first\n- second\n  1. nested",
  "```ts\nconst a = 1;\n```",
  "> quoted",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "---",
].join("\n\n");

describe("adf", () => {
  it("writes markdown as a Jira document and reads it back unchanged", () => {
    expect(adfToMarkdown(markdownToAdf(MARKDOWN))).toBe(MARKDOWN);
  });

  it("writes only nodes Jira's schema accepts where markdown put them", () => {
    const document = markdownToAdf("- [x] **`done`** [`link`](https://a.test)\n\n  ## inside");
    expect(document.content).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "[x] " },
                  // Code drops the bold beside it and keeps the link.
                  { type: "text", text: "done", marks: [{ type: "code" }] },
                  { type: "text", text: " " },
                  {
                    type: "text",
                    text: "link",
                    marks: [{ type: "link", attrs: { href: "https://a.test" } }, { type: "code" }],
                  },
                ],
              },
              // A heading cannot sit in a list item.
              { type: "paragraph", content: [{ type: "text", text: "inside" }] },
            ],
          },
        ],
      },
    ]);
  });

  it("reads what markdown cannot say as text and reports it as unwritable", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "1", text: "@Theo" } },
            { type: "text", text: " see " },
            { type: "inlineCard", attrs: { url: "https://acme.atlassian.net/browse/ENG-1" } },
          ],
        },
        { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m" } }] },
      ],
    };
    expect(adfToMarkdown(document)).toBe(
      "@Theo see https://acme.atlassian.net/browse/ENG-1\n\n_(attachment)_",
    );
    expect(hasUnwritableContent(document)).toBe(true);
    expect(hasUnwritableContent(markdownToAdf(MARKDOWN))).toBe(false);
    expect(adfToMarkdown(null)).toBe("");
  });
});
