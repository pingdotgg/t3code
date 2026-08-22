import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import { autolinkMarkdownUrls } from "@t3tools/mobile-markdown-text/autolink";
import { nativeMarkdownDocumentRuns } from "@t3tools/mobile-markdown-text/markdown";

const REPORTED_URL = "https://passpage.space/v/EU7PayhOU9PDVIXUPjT8x_/";

function paragraph(...children: MarkdownNode[]): MarkdownNode {
  return { type: "paragraph", children };
}

function linkedHrefs(node: MarkdownNode): string[] {
  const hrefs: string[] = [];
  const visit = (current: MarkdownNode) => {
    if (current.type === "link" && current.href) {
      hrefs.push(current.href);
    }
    for (const child of current.children ?? []) {
      visit(child);
    }
  };
  visit(node);
  return hrefs;
}

describe("autolinkMarkdownUrls", () => {
  it("linkifies the reported underscore URL md4c leaves as text", () => {
    const node = paragraph({
      type: "text",
      content: `Here it is ${REPORTED_URL} enjoy`,
    });

    expect(autolinkMarkdownUrls(node)).toEqual(
      paragraph(
        { type: "text", content: "Here it is " },
        {
          type: "link",
          href: REPORTED_URL,
          children: [{ type: "text", content: REPORTED_URL }],
        },
        { type: "text", content: " enjoy" },
      ),
    );
  });

  it("linkifies the reported URL inside bold emphasis", () => {
    const node = paragraph({
      type: "bold",
      children: [{ type: "text", content: REPORTED_URL }],
    });

    expect(autolinkMarkdownUrls(node)).toEqual(
      paragraph({
        type: "bold",
        children: [
          {
            type: "link",
            href: REPORTED_URL,
            children: [{ type: "text", content: REPORTED_URL }],
          },
        ],
      }),
    );
  });

  it("linkifies underscore variants md4c rejects", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // A trailing "_" is GFM trailing punctuation, so it stays outside the link.
      ["https://example.com/x_", "https://example.com/x"],
      ["https://example.com/_x", "https://example.com/_x"],
      ["https://example.com/a__b", "https://example.com/a__b"],
      ["https://example.com/café_test", "https://example.com/café_test"],
    ];

    for (const [content, href] of cases) {
      expect(linkedHrefs(autolinkMarkdownUrls(paragraph({ type: "text", content })))).toEqual([
        href,
      ]);
    }
  });

  it("trims trailing punctuation but keeps balanced parentheses", () => {
    expect(
      autolinkMarkdownUrls(paragraph({ type: "text", content: "see https://example.com/x_y." })),
    ).toEqual(
      paragraph(
        { type: "text", content: "see " },
        {
          type: "link",
          href: "https://example.com/x_y",
          children: [{ type: "text", content: "https://example.com/x_y" }],
        },
        { type: "text", content: "." },
      ),
    );

    expect(
      autolinkMarkdownUrls(paragraph({ type: "text", content: "(https://example.com/x_)" })),
    ).toEqual(
      paragraph(
        { type: "text", content: "(" },
        {
          type: "link",
          href: "https://example.com/x",
          children: [{ type: "text", content: "https://example.com/x" }],
        },
        { type: "text", content: "_)" },
      ),
    );

    expect(
      linkedHrefs(
        autolinkMarkdownUrls(
          paragraph({ type: "text", content: "https://en.wikipedia.org/wiki/Foo_(bar)" }),
        ),
      ),
    ).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });

  it("prefixes bare www hosts with http", () => {
    expect(
      autolinkMarkdownUrls(paragraph({ type: "text", content: "www.example.com/a_b" })),
    ).toEqual(
      paragraph({
        type: "link",
        href: "http://www.example.com/a_b",
        children: [{ type: "text", content: "www.example.com/a_b" }],
      }),
    );
  });

  it("linkifies dotless hosts such as localhost", () => {
    expect(
      linkedHrefs(
        autolinkMarkdownUrls(paragraph({ type: "text", content: "http://localhost:3000/path_" })),
      ),
    ).toEqual(["http://localhost:3000/path"]);
  });

  it("linkifies every URL in a single text node", () => {
    expect(
      linkedHrefs(
        autolinkMarkdownUrls(
          paragraph({
            type: "text",
            content: `${REPORTED_URL} and https://example.com/b_ and www.other.dev/c_`,
          }),
        ),
      ),
    ).toEqual([REPORTED_URL, "https://example.com/b", "http://www.other.dev/c"]);
  });

  it("never descends into links, code, html, or math", () => {
    const link: MarkdownNode = {
      type: "link",
      href: REPORTED_URL,
      children: [{ type: "text", content: REPORTED_URL }],
    };
    const codeInline: MarkdownNode = { type: "code_inline", content: REPORTED_URL };
    const codeBlock: MarkdownNode = {
      type: "code_block",
      language: "sh",
      content: `curl ${REPORTED_URL}`,
    };
    const htmlInline: MarkdownNode = { type: "html_inline", content: `<i>${REPORTED_URL}</i>` };
    const mathInline: MarkdownNode = { type: "math_inline", content: REPORTED_URL };
    const node = paragraph(link, codeInline, codeBlock, htmlInline, mathInline);

    const result = autolinkMarkdownUrls(node);

    expect(result).toBe(node);
    expect(linkedHrefs(result)).toEqual([REPORTED_URL]);
  });

  it("returns the same reference when nothing changes", () => {
    const plain = paragraph({ type: "text", content: "no urls here, just prose." });
    expect(autolinkMarkdownUrls(plain)).toBe(plain);

    const document: MarkdownNode = {
      type: "document",
      children: [paragraph({ type: "text", content: "still nothing to linkify" })],
    };
    expect(autolinkMarkdownUrls(document)).toBe(document);
  });

  it("feeds the iOS run builder an href-carrying run inside bold", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        paragraph(
          { type: "text", content: "Open " },
          { type: "bold", children: [{ type: "text", content: REPORTED_URL }] },
          { type: "text", content: " now" },
        ),
      ],
    };

    const runs = nativeMarkdownDocumentRuns(autolinkMarkdownUrls(document));
    const linkRun = runs.find((run) => run.href !== undefined);

    expect(linkRun).toMatchObject({
      text: REPORTED_URL,
      href: REPORTED_URL,
      externalHost: "passpage.space",
      bold: true,
    });
  });
});
