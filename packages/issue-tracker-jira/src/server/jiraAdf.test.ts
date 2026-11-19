import { describe, expect, it } from "@effect/vitest";

import { adfToMarkdown, markdownToAdf } from "./jiraAdf.ts";

const text = (value: string, marks?: ReadonlyArray<unknown>) =>
  marks === undefined ? { type: "text", text: value } : { type: "text", text: value, marks };

describe("jiraAdf", () => {
  it("reads a Jira document as Markdown, naming what Markdown cannot hold", () => {
    expect(
      adfToMarkdown({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              text("See "),
              text("the guide", [
                { type: "link", attrs: { href: "https://x.test" } },
                { type: "strong" },
              ]),
              { type: "hardBreak" },
              { type: "mention", attrs: { id: "abc", text: "@Theo" } },
            ],
          },
          {
            type: "orderedList",
            attrs: { order: 3 },
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [text("three")] }] },
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [text("four")] },
                  {
                    type: "bulletList",
                    content: [
                      {
                        type: "listItem",
                        content: [{ type: "paragraph", content: [text("nested")] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;")] },
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  { type: "tableHeader", content: [{ type: "paragraph", content: [text("a|b")] }] },
                ],
              },
              {
                type: "tableRow",
                content: [
                  { type: "tableCell", content: [{ type: "paragraph", content: [text("1")] }] },
                ],
              },
            ],
          },
          { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1" } }] },
        ],
      }),
    ).toBe(
      [
        "See [**the guide**](https://x.test)\n@Theo",
        "3. three\n4. four\n   - nested",
        "```ts\nconst a = 1;\n```",
        "| a\\|b |\n| --- |\n| 1 |",
        "_(attachment, open in Jira to view)_",
      ].join("\n\n"),
    );
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown({ type: "doc", version: 1, content: [] })).toBe("");
  });

  it("writes Markdown as the document Jira's editor would have stored", () => {
    expect(
      markdownToAdf("# Title\n\n> quoted *text*\n\n1. one\n\n---\n\n[`code` link](https://x.test)"),
    ).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 1 }, content: [text("Title")] },
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [text("quoted "), text("text", [{ type: "em" }])] },
          ],
        },
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("one")] }] }],
        },
        { type: "rule" },
        {
          type: "paragraph",
          content: [
            // Jira allows only a link beside a code mark.
            text("code", [{ type: "link", attrs: { href: "https://x.test" } }, { type: "code" }]),
            text(" link", [{ type: "link", attrs: { href: "https://x.test" } }]),
          ],
        },
      ],
    });
    expect(markdownToAdf("")).toEqual({ type: "doc", version: 1, content: [] });
  });

  it("keeps a document's text through a round trip", () => {
    const markdown = "Fix **this** and ~~that~~.\n\n- one\n- two\n\n```\nraw\n```";
    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown);
  });
});
