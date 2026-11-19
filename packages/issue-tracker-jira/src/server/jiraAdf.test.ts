import { describe, expect, it } from "@effect/vitest";

import { adfToMarkdown, hasJiraOnlyContent, markdownToAdf } from "./jiraAdf.ts";

const text = (value: string, marks?: ReadonlyArray<unknown>) =>
  marks === undefined ? { type: "text", text: value } : { type: "text", text: value, marks };
const doc = (...content: ReadonlyArray<unknown>) => ({ type: "doc", version: 1, content });
const paragraph = (...content: ReadonlyArray<unknown>) => ({ type: "paragraph", content });
const item = (...content: ReadonlyArray<unknown>) => ({ type: "listItem", content });
const link = { type: "link", attrs: { href: "https://x.test" } };

describe("jiraAdf", () => {
  it("reads a Jira document as Markdown, naming what Markdown cannot hold", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(text("the guide", [link, { type: "strong" }]), {
            type: "mention",
            attrs: { text: "@Theo" },
          }),
          {
            type: "orderedList",
            attrs: { order: 3 },
            content: [
              item(paragraph(text("three")), {
                type: "bulletList",
                content: [item(paragraph(text("nested")))],
              }),
            ],
          },
          { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1" } }] },
        ),
      ),
    ).toBe(
      "[**the guide**](https://x.test)@Theo\n\n3. three\n   - nested\n\n_(attachment, open in Jira to view)_",
    );
  });

  it("writes Markdown as the document Jira's editor would have stored", () => {
    // Jira allows only a link beside a code mark; the first definition of a reference wins.
    expect(
      markdownToAdf("[`code` link][g]\n\n> [g]: https://x.test\n\n[g]: https://y.test").content[0],
    ).toEqual(paragraph(text("code", [link, { type: "code" }]), text(" link", [link])));
  });

  it("keeps a document's text through a round trip", () => {
    const markdown = "Fix **this** and ~~that~~.\n\n- one\n- two\n\n```\nraw\n```";
    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown);
    // Literal Markdown characters and a fence inside code stay what Jira stored.
    const literal = doc(
      paragraph(text("**draft** [x]"), text("a`b", [{ type: "code" }])),
      paragraph(text("1. not a list")),
      { type: "codeBlock", content: [text("```\nstill code")] },
    );
    expect(markdownToAdf(adfToMarkdown(literal))).toEqual(literal);
  });

  it("treats only what Markdown would lose as Jira-only", () => {
    const table = (attrs: Record<string, unknown>) =>
      doc({
        type: "table",
        content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs }] }],
      });
    expect(hasJiraOnlyContent(table({ colspan: 1 }))).toBe(false);
    expect(hasJiraOnlyContent(table({ colspan: 2 }))).toBe(true);
    expect(hasJiraOnlyContent(doc(paragraph(text("x", [{ type: "textColor" }]))))).toBe(true);
  });
});
