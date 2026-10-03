import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { renderAssistantInsightsAsMarkdown } from "./assistantInsights.ts";

const parser = unified().use(remarkParse);

function parse(markdown: string) {
  return parser.parse(renderAssistantInsightsAsMarkdown(markdown));
}

describe("renderAssistantInsightsAsMarkdown", () => {
  it.each(["\r\n", "\r"])("handles %j line endings", (lineEnding) => {
    const lines = ["★ Insight ─────", "First.", "Second.", "─────", "After."];
    expect(renderAssistantInsightsAsMarkdown(lines.join(lineEnding))).toBe(
      renderAssistantInsightsAsMarkdown(lines.join("\n")),
    );
  });

  it.each(["", "`"])(
    "renders %s-wrapped fences and preserves breaks only inside insights",
    (wrap) => {
      const tree = parse(
        [
          "Ordinary prose",
          "still one paragraph.",
          "",
          `${wrap}★ Insight ─────────────────────────${wrap}`,
          "First observation.",
          "Second **observation**.",
          `${wrap}──────────────────────────────────${wrap}`,
          "After the insight.",
        ].join("\n"),
      );

      expect(tree.children).toMatchObject([
        {
          type: "paragraph",
          children: [{ type: "text", value: "Ordinary prose\nstill one paragraph." }],
        },
        {
          type: "blockquote",
          children: [
            {
              type: "paragraph",
              children: [{ type: "strong", children: [{ value: "★ Insight" }] }],
            },
            {
              type: "paragraph",
              children: [
                { type: "text", value: "First observation." },
                { type: "break" },
                { type: "text", value: "Second " },
                { type: "strong", children: [{ value: "observation" }] },
                { type: "text", value: "." },
              ],
            },
          ],
        },
        { type: "paragraph", children: [{ value: "After the insight." }] },
      ]);
    },
  );

  it("preserves lists, links, and literal code inside an insight", () => {
    const tree = parse(
      [
        "★ Insight ─────",
        "- Use **stable keys**.",
        "- Read [the docs](https://example.com).",
        "",
        "```text",
        "★ Insight ─────",
        "  literal content",
        "─────",
        "```",
        "─────",
        "Done.",
      ].join("\n"),
    );
    expect(tree.children).toMatchObject([
      {
        type: "blockquote",
        children: [
          { type: "paragraph" },
          {
            type: "list",
            children: [
              { type: "listItem" },
              {
                type: "listItem",
                children: [
                  {
                    children: [
                      { type: "text", value: "Read " },
                      { type: "link", url: "https://example.com" },
                      { type: "text", value: "." },
                    ],
                  },
                ],
              },
            ],
          },
          { type: "code", lang: "text", value: "★ Insight ─────\n  literal content\n─────" },
        ],
      },
      { type: "paragraph", children: [{ value: "Done." }] },
    ]);
  });

  it.each([
    "Regular\r\nMarkdown.",
    "★ Insight is a useful label.\n─────",
    "```text\n★ Insight ─────\nExample\n─────\n```",
    "~~~~\n★ Insight ─────\nExample\n─────\n~~~~",
    "    ★ Insight ─────\n    Example\n    ─────",
    "`multiline\n★ Insight ─────\nExample\n─────\ncode`",
    "<pre>\n★ Insight ─────\nExample\n─────\n</pre>",
  ])("leaves non-insight text and literal examples unchanged: %s", (markdown) => {
    expect(renderAssistantInsightsAsMarkdown(markdown)).toBe(markdown);
  });

  it("renders multiple insights and an unfinished streaming body", () => {
    const text = "★ Insight ─────\nFirst.\n─────\nBetween.\n★ Insight ─────\nSecond";
    const tree = parse(text);
    expect(tree.children.map((node) => node.type)).toEqual([
      "blockquote",
      "paragraph",
      "blockquote",
    ]);
    expect(tree.children.at(-1)).toMatchObject({
      children: [{ type: "paragraph" }, { type: "paragraph", children: [{ value: "Second" }] }],
    });
    expect(parse(`${text}.\n─────\nAfter.`).children.at(-1)).toMatchObject({
      type: "paragraph",
      children: [{ value: "After." }],
    });
  });

  it.each(["- ", "1. ", "10. "])("keeps insights inside a %slist item", (marker) => {
    const indent = " ".repeat(marker.length);
    const tree = parse(
      [
        `${marker}Parent`,
        "",
        `${indent}★ Insight ─────`,
        `${indent}First.`,
        `${indent}Second.`,
        `${indent}─────`,
        `${indent}Still inside the list.`,
      ].join("\n"),
    );
    expect(tree.children).toMatchObject([
      {
        type: "list",
        children: [
          {
            type: "listItem",
            children: [
              { type: "paragraph", children: [{ value: "Parent" }] },
              {
                type: "blockquote",
                children: [
                  { type: "paragraph" },
                  {
                    type: "paragraph",
                    children: [{ value: "First." }, { type: "break" }, { value: "Second." }],
                  },
                ],
              },
              { type: "paragraph", children: [{ value: "Still inside the list." }] },
            ],
          },
        ],
      },
    ]);
  });
});
