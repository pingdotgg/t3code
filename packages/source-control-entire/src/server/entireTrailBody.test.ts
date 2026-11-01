import { describe, expect, it } from "@effect/vitest";

import { trailBodyMarkdown, unpreservedMarkdown } from "./entireTrailBody.ts";

const text = (value: string, marks?: ReadonlyArray<Record<string, unknown>>) => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: ReadonlyArray<unknown>) => ({ type: "paragraph", content });

describe("trailBodyMarkdown", () => {
  it("renders headings, lists, code and inline marks as markdown", () => {
    const content_json = {
      type: "doc",
      content: [
        paragraph(
          text(
            "<!-- entire-trail-link-start --> https://entire.io/gh/o/r/trails/1 <!-- entire-trail-link-end -->",
          ),
        ),
        { type: "heading", attrs: { level: 2 }, content: [text("Summary")] },
        paragraph(
          text("Keeps "),
          text("secrets", [{ type: "bold" }]),
          text(" out of "),
          text("transcript.jsonl", [{ type: "code" }]),
          text("; see "),
          text("docs", [{ type: "link", attrs: { href: "https://entire.io/docs" } }]),
          text("."),
        ),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph(text("first"))] },
            {
              type: "listItem",
              content: [
                paragraph(text("second")),
                {
                  type: "bulletList",
                  content: [{ type: "listItem", content: [paragraph(text("nested"))] }],
                },
              ],
            },
          ],
        },
        { type: "codeBlock", attrs: { language: "go" }, content: [text("x := 1")] },
      ],
    };
    expect(trailBodyMarkdown({ text_snapshot: "flat", content_json })).toBe(
      [
        "## Summary",
        "",
        "Keeps **secrets** out of `transcript.jsonl`; see [docs](https://entire.io/docs).",
        "",
        "- first",
        "- second",
        "  - nested",
        "",
        "```go",
        "x := 1",
        "```",
      ].join("\n"),
    );
  });

  it("renders italics and hard breaks as Entire's markdown converter reads them back", () => {
    const content_json = {
      type: "doc",
      content: [
        paragraph(
          text("Mostly "),
          text("fine", [{ type: "italic" }]),
          { type: "hardBreak" },
          text("on the next line"),
        ),
      ],
    };
    const markdown = trailBodyMarkdown({ text_snapshot: "", content_json });
    expect(markdown).toBe("Mostly *fine*\\\non the next line");
    // So a description holding only these can be edited from T3 Code.
    expect(unpreservedMarkdown(markdown)).toBeNull();
  });

  it("keeps code blocks' blank lines", () => {
    const content_json = {
      type: "doc",
      content: [{ type: "codeBlock", content: [text("a\n\n\nb")] }, paragraph(text("after"))],
    };
    expect(trailBodyMarkdown({ text_snapshot: "", content_json })).toBe(
      "```\na\n\n\nb\n```\n\nafter",
    );
  });

  it("escapes text that markdown would read as formatting, and won't rewrite it", () => {
    const content_json = {
      type: "doc",
      content: [
        paragraph(text("**Mercury**, snake_case, _x_, ~~y~~, [a](b), `c` and C:\\*")),
        paragraph(text("2 * 3 = 6, user_id, [WIP]")),
        ...["# heading", "> quote", "- item", "1. item"].map((value) => paragraph(text(value))),
      ],
    };
    const markdown = trailBodyMarkdown({ text_snapshot: "", content_json });
    expect(markdown).toBe(
      [
        "\\*\\*Mercury\\*\\*, snake_case, \\_x\\_, \\~\\~y\\~\\~, \\[a](b), \\`c\\` and C:\\\\\\*",
        "",
        "2 * 3 = 6, user_id, [WIP]",
        "",
        "\\# heading",
        "",
        "\\> quote",
        "",
        "\\- item",
        "",
        "1\\. item",
      ].join("\n"),
    );
    // Entire's converter reads no escapes, so saving them back would keep the backslashes.
    expect(unpreservedMarkdown(markdown)).toBe("escaped markdown characters");
    for (const value of ["\\# heading", "\\> quote", "\\- item", "1\\. item"]) {
      expect(unpreservedMarkdown(value)).toBe("escaped markdown characters");
    }
    expect(unpreservedMarkdown("2 * 3 = 6, user_id, [WIP]")).toBeNull();
  });

  it("delimits code by more backticks than it holds, which Entire can't read back", () => {
    const content_json = {
      type: "doc",
      content: [
        paragraph(text("a`b", [{ type: "code" }]), text(" and "), text("`x", [{ type: "code" }])),
        { type: "codeBlock", content: [text("````\ninner\n````")] },
      ],
    };
    const markdown = trailBodyMarkdown({ text_snapshot: "", content_json });
    expect(markdown).toBe(
      ["``a`b`` and `` `x ``", "", "`````", "````", "inner", "````", "`````"].join("\n"),
    );
    expect(unpreservedMarkdown("``a`b`` and more")).toBe("code containing backticks");
    expect(unpreservedMarkdown("`````\n````\n`````")).toBe("code blocks containing fences");
  });

  it("keeps link text but drops links that aren't web or mail links", () => {
    const content_json = {
      type: "doc",
      content: [
        paragraph(text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])),
      ],
    };
    expect(trailBodyMarkdown({ text_snapshot: "", content_json })).toBe("click");
  });

  it("falls back to the snapshot without the trail self-link", () => {
    expect(
      trailBodyMarkdown({
        text_snapshot:
          "<!-- entire-trail-link-start --> https://entire.io/gh/o/r/trails/1 <!-- entire-trail-link-end -->\nThe body",
        content_json: "not a document",
      }),
    ).toBe("The body");
  });
});

describe("unpreservedMarkdown", () => {
  it.each([
    ["underscore italic", "Some _emphasis_ here", "underscore emphasis"],
    ["underscore bold", "Some __strong__ here", "underscore emphasis"],
    ["strikethrough", "Drop ~~this~~ now", "strikethrough"],
    ["a nested list", "- one\n  - two", "nested or continued list items"],
    ["a continued list item", "- one\n  more of one", "nested or continued list items"],
    ["an ordered list from 3", "3. three\n4. four", "numbered lists that don't start at 1"],
    ["a fenced code language", "```ts\nconst a = 1\n```", "code block languages"],
    ["bold italic text", "Very ***loud*** here", "bold italic text"],
    ["a multi-paragraph quote", "> one\n>\n> two", "quotes of more than one paragraph"],
  ] as const)("finds %s", (_, markdown, lost) => {
    expect(unpreservedMarkdown(markdown)).toBe(lost);
  });

  it("passes what Entire's converter keeps", () => {
    const markdown = [
      "## Summary",
      "",
      "Keeps **secrets** and *this* out of `snake_case_name`; see [docs](https://entire.io/docs).",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "```",
      "a_b ~~c~~",
      "  - not a list",
      "```",
      "",
      "> A quote",
      "",
      "Ends with a break  ",
      "and goes on\\",
      "and on, then wraps",
      "softly, as markdown joins it.",
      "",
      "---",
    ].join("\n");
    expect(unpreservedMarkdown(markdown)).toBeNull();
    expect(unpreservedMarkdown("")).toBeNull();
  });
});
