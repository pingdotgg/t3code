import { describe, expect, it } from "@effect/vitest";

import { adfToMarkdown, hasUnwritableContent, markdownToAdf } from "./adf.ts";

const MARKDOWN = [
  "# Crash on launch",
  "Opens **then** *dies* with `EPIPE`, see [the log](https://logs.test/1).",
  "- first\n- second\n  1. nested",
  "```ts\nconst a = 1;\n```",
  "> quoted",
  "- [x] shipped\n- [ ] review",
  "## Release \\#",
  "Line one\\\nline two, [go](https://a.test/a\\)b) and [docs](<https://a.test/a\\\\) b>)",
  "- first\n\n  second\n\n  2. third",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "---",
  // Jira text that only looks like markdown stays literal.
  String.raw`Typed \*stars\*, \_under\_ but snake_case, \~\~gone\~\~, \[box\] \<b> \& a \\ \`tick\``,
  "\\# heading\n\\> quote\n\\- list\n\\+ list\n1\\. list\n2\\) list\n\\=== setext",
  // Code holding backticks gets a longer fence.
  "Run ``a ` b`` or `` `edge` `` or `  padded  `.",
  "````md\n```\nnested\n```\n````",
].join("\n\n");

describe("adf", () => {
  it("writes markdown as a Jira document and reads it back unchanged", () => {
    const document = markdownToAdf(MARKDOWN);
    expect(adfToMarkdown(document)).toBe(MARKDOWN);
    // https://github.com/pingdotgg/t3code/pull/38003#issuecomment-7101618257
    expect(document.content?.find((node) => node.type === "taskList")?.content).toMatchObject([
      { type: "taskItem", attrs: { state: "DONE" }, content: [{ text: "shipped" }] },
      { type: "taskItem", attrs: { state: "TODO" }, content: [{ text: "review" }] },
    ]);
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
    // Nested bold is one strong mark, and a list from 1 states no start, as Jira's editor does.
    const strong = [{ type: "strong" }];
    expect(markdownToAdf("1. **a **b** c**").content).toEqual([
      {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "a ", marks: strong },
                  { type: "text", text: "b", marks: strong },
                  { type: "text", text: " c", marks: strong },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  // https://github.com/pingdotgg/t3code/pull/38003#discussion_r4717362382
  it("keeps edge spaces outside marks and table cells it cannot rewrite", () => {
    const text = (value: string, marks?: ReadonlyArray<{ type: string }>) => ({
      type: "text",
      text: value,
      ...(marks ? { marks } : {}),
    });
    const document = {
      type: "doc",
      content: [
        { type: "paragraph", content: [text("bold ", [{ type: "strong" }]), text("next")] },
      ],
    };
    expect(adfToMarkdown(document)).toBe("**bold** next");
    expect(markdownToAdf(adfToMarkdown(document)).content?.[0]?.content?.[0]).toMatchObject({
      text: "bold",
      marks: [{ type: "strong" }],
    });
    const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
    const cell = (...content: ReadonlyArray<unknown>) => ({ type: "tableCell", content });
    const table = (first: unknown) => ({
      type: "doc",
      content: [{ type: "table", content: [{ type: "tableRow", content: [first] }] }],
    });
    expect(hasUnwritableContent(table(cell(paragraph("alpha"))))).toBe(false);
    expect(hasUnwritableContent(table(cell(paragraph("alpha"), paragraph("beta"))))).toBe(true);
    const bullets = {
      type: "bulletList",
      content: [{ type: "listItem", content: [paragraph("a")] }],
    };
    expect(hasUnwritableContent(table(cell(bullets)))).toBe(true);
    const broken = { type: "paragraph", content: [text("a"), { type: "hardBreak" }, text("b")] };
    expect(hasUnwritableContent(table(cell(broken)))).toBe(true);
  });

  it("writes a reference link as the inline link its first definition names", () => {
    const markdown = [
      "See [the log][log] and ![shot][img].",
      "[log]: https://logs.test/1\n[Log]: https://logs.test/2\n[img]: https://img.test/a.png",
    ].join("\n\n");
    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(
      "See [the log](https://logs.test/1) and [shot](https://img.test/a.png).",
    );
  });

  it("reads what markdown cannot say as text and reports it as unwritable", () => {
    const text = (value: string) => ({ type: "text", text: value });
    const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
    const mention = { type: "mention", attrs: { id: "1", text: "@Theo" } };
    const card = { type: "inlineCard", attrs: { url: "https://acme.atlassian.net/browse/ENG-1" } };
    const status = { type: "status", attrs: { text: "In Progress", color: "blue" } };
    const emoji = { type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } };
    const underlined = { ...text(" today"), marks: [{ type: "underline" }] };
    const mergedHeader = {
      type: "tableHeader",
      attrs: { colspan: 2 },
      content: [paragraph("Both")],
    };
    const document = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            mention,
            text(" see "),
            card,
            text(" is "),
            status,
            text(" "),
            emoji,
            underlined,
          ],
        },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [mergedHeader] },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [paragraph("1")] },
                { type: "tableCell", content: [paragraph("2")] },
              ],
            },
          ],
        },
        { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m" } }] },
      ],
    };
    expect(adfToMarkdown(document)).toBe(
      [
        "@Theo see https://acme.atlassian.net/browse/ENG-1 is In Progress 🎉 today",
        "| Both |  |\n| --- | --- |\n| 1 | 2 |",
        "_(attachment, open in Jira to view)_",
      ].join("\n\n"),
    );
    // Each of these alone is something a rewrite from markdown would drop or flatten.
    const lossy = [
      mention,
      card,
      status,
      emoji,
      underlined,
      { ...text("red"), marks: [{ type: "textColor", attrs: { color: "#ff0000" } }] },
      { ...text("2"), marks: [{ type: "subsup", attrs: { type: "sup" } }] },
      { ...paragraph("centred"), marks: [{ type: "alignment", attrs: { align: "center" } }] },
      mergedHeader,
      { type: "tableCell", attrs: { rowspan: 2 }, content: [paragraph("tall")] },
    ];
    expect(lossy.filter((node) => !hasUnwritableContent({ type: "doc", content: [node] }))).toEqual(
      [],
    );
    expect(hasUnwritableContent(document)).toBe(true);
    expect(hasUnwritableContent(markdownToAdf(MARKDOWN))).toBe(false);
    expect(adfToMarkdown(null)).toBe("");
  });
});
