import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
  nativeMarkdownListItemBlocks,
  nativeMarkdownTextRuns,
  nativeMarkdownWithPreservedSoftBreaks,
  nativeMarkdownContextCopyRanges,
  contextChipPresentation,
} from "@t3tools/mobile-markdown-text/markdown";

describe("nativeMarkdownTextRuns", () => {
  it("distinguishes video and pull-request context from generic file and review chips", () => {
    expect(
      contextChipPresentation("file", {
        name: "recording.webm",
        mimeType: "application/octet-stream",
      }),
    ).toEqual(contextChipPresentation("video"));
    expect(contextChipPresentation("review-comment", { sectionId: "pull-request:284" })).toEqual(
      contextChipPresentation("pull-request"),
    );
    expect(contextChipPresentation("review-comment", { sectionId: "git:working-tree" })).toEqual(
      contextChipPresentation("review-comment"),
    );
  });

  it("renders a video-named file with a declared document MIME type as a file chip", () => {
    expect(
      contextChipPresentation("file", {
        name: "recording.mp4",
        mimeType: "application/pdf",
      }),
    ).toEqual(contextChipPresentation("file"));
  });

  it("maps rendered selection offsets back to canonical references without losing repeated chips", () => {
    const href = "t3-context://v1/image/screenshot";
    expect(
      nativeMarkdownContextCopyRanges([
        { run: { text: "😀 " }, text: "😀 ", inlineImageLength: 0 },
        { run: { href, text: "Checkout" }, text: "Checkout", inlineImageLength: 1 },
        { run: { text: " then " }, text: " then ", inlineImageLength: 0 },
        { run: { href, text: "Checkout" }, text: "\uFFFC\u00A0Checkout", inlineImageLength: 0 },
      ]),
    ).toEqual([
      { start: 3, end: 12, text: "![Checkout](t3-context://v1/image/screenshot)" },
      { start: 18, end: 28, text: "![Checkout](t3-context://v1/image/screenshot)" },
    ]);
  });
  it("restores canonical skill and context text from Android's single-image chips", () => {
    expect(
      nativeMarkdownContextCopyRanges([
        { run: { text: "Use " }, text: "Use ", inlineImageLength: 0 },
        { run: { text: "Playwright", skillName: "playwright" }, text: "", inlineImageLength: 1 },
        { run: { text: " on " }, text: " on ", inlineImageLength: 0 },
        {
          run: { text: "Screenshot", href: "t3-context://v1/image/screenshot" },
          text: "",
          inlineImageLength: 1,
        },
      ]),
    ).toEqual([
      { start: 4, end: 5, text: "$playwright" },
      { start: 9, end: 10, text: "![Screenshot](t3-context://v1/image/screenshot)" },
    ]);
  });
  it("links a path-shaped code span without changing the same path in prose", () => {
    expect(
      nativeMarkdownTextRuns({
        type: "paragraph",
        children: [
          { type: "text", content: "/tmp/frame.png " },
          { type: "code_inline", content: "/tmp/frame.png" },
        ],
      }),
    ).toEqual([
      { text: "/tmp/frame.png " },
      { text: "frame.png", href: "/tmp/frame.png", fileIcon: "image" },
    ]);
  });

  it("preserves the destination of a link with a code-formatted label", () => {
    expect(
      nativeMarkdownTextRuns({
        type: "paragraph",
        children: [
          {
            type: "link",
            href: "https://example.com/docs",
            children: [{ type: "code_inline", content: "src/main.ts" }],
          },
        ],
      }),
    ).toEqual([
      {
        text: "src/main.ts",
        code: true,
        href: "https://example.com/docs",
        externalHost: "example.com",
      },
    ]);
  });

  it("preserves inline emphasis and code styles", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        { type: "text", content: "plain " },
        { type: "bold", children: [{ type: "text", content: "bold" }] },
        { type: "text", content: " " },
        { type: "code_inline", content: "const value = 1" },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([
      { text: "plain " },
      { text: "bold", bold: true },
      { text: " " },
      { text: "const value = 1", code: true },
    ]);
  });

  it("normalizes external and file links for native presentation", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        {
          type: "link",
          href: "https://example.com/docs",
          children: [{ type: "text", content: "Docs" }],
        },
        { type: "text", content: " " },
        {
          type: "link",
          href: "file:///repo/README.md#L12",
          children: [{ type: "text", content: "ignored label" }],
        },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([
      {
        text: "Docs",
        href: "https://example.com/docs",
        externalHost: "example.com",
      },
      { text: " " },
      {
        text: "README.md:12",
        href: "file:///repo/README.md#L12",
        fileIcon: "readme",
      },
    ]);
  });

  it("keeps hard breaks and collapses soft breaks", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        { type: "text", content: "first" },
        { type: "soft_break" },
        { type: "text", content: "second" },
        { type: "line_break" },
        { type: "text", content: "third" },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([{ text: "first second\nthird" }]);
  });

  it("can preserve soft breaks for authored user messages", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        { type: "text", content: "first" },
        { type: "soft_break" },
        { type: "text", content: "second" },
      ],
    };

    expect(nativeMarkdownTextRuns(nativeMarkdownWithPreservedSoftBreaks(node))).toEqual([
      { text: "first\nsecond" },
    ]);
  });

  it("normalizes common inline HTML and entities", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        { type: "text", content: "Less than: &lt; " },
        { type: "html_inline", content: "<kbd>" },
        { type: "text", content: "⌘" },
        { type: "html_inline", content: "</kbd>" },
        { type: "html_inline", content: "<br />" },
        { type: "html_inline", content: "<mark>highlighted</mark>" },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([{ text: "Less than: < ⌘\nhighlighted" }]);
  });

  it("normalizes double-encoded entities and inline tags emitted as text", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        {
          type: "text",
          content:
            "Keyboard: <kbd>⌘</kbd> + <kbd>K</kbd>; Less than: &amp;lt;; Greater than: &amp;gt;",
        },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([
      { text: "Keyboard: ⌘ + K; Less than: <; Greater than: >" },
    ]);
  });

  it.each([
    ["&#128512;", "😀"],
    ["&#x1f680;", "🚀"],
    ["&#9999999999;", "&#9999999999;"],
    ["&#x110000;", "&#x110000;"],
    ["&amp;#9999999999;", "&#9999999999;"],
    ["&amp;#x110000;", "&#x110000;"],
  ])("normalizes numeric entity %s without throwing", (content, expected) => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [{ type: "text", content }],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([{ text: expected }]);
  });

  it("reads inline content from nested text nodes", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        {
          type: "text",
          children: [{ type: "text", content: "Plain text" }],
        },
        { type: "text", content: " and " },
        {
          type: "code_inline",
          children: [{ type: "text", content: "inline code" }],
        },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([
      { text: "Plain text and " },
      { text: "inline code", code: true },
    ]);
  });
});

describe("nativeMarkdownDocumentRuns", () => {
  it("renders a file mention without swallowing sentence punctuation or changing package references", () => {
    const runs = nativeMarkdownDocumentRuns({
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", content: "Inspect @src/Checkout.tsx. Use @t3tools/contracts." },
          ],
        },
      ],
    });
    expect(runs).toEqual([
      { text: "Inspect ", role: "body" },
      {
        text: "Checkout.tsx",
        role: "body",
        href: "src/Checkout.tsx",
        fileIcon: "react",
        sourceText: "@src/Checkout.tsx",
      },
      { text: ". Use @t3tools/contracts.", role: "body" },
    ]);
  });

  it("copies collapsed skill and file chips back to their original references", () => {
    expect(
      nativeMarkdownContextCopyRanges([
        { run: { text: "$ui", skillName: "ui" }, text: "\uFFFC", inlineImageLength: 0 },
        { run: { text: " and " }, text: " and ", inlineImageLength: 0 },
        {
          run: {
            text: "Checkout.tsx",
            href: "src/Checkout.tsx",
            fileIcon: "react",
            sourceText: "@src/Checkout.tsx",
          },
          text: "\uFFFC",
          inlineImageLength: 0,
        },
      ]),
    ).toEqual([
      { start: 0, end: 1, text: "$ui" },
      { start: 6, end: 7, text: "@src/Checkout.tsx" },
    ]);
  });

  it("decorates known skill references as selectable skill links", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Use $ui for this." }],
        },
      ],
    };

    expect(nativeMarkdownDocumentRuns(node, [{ name: "ui", displayName: "UI" }])).toEqual([
      { text: "Use ", role: "body" },
      {
        text: "$ui",
        role: "body",
        skillName: "ui",
        skillLabel: "UI",
      },
      { text: " for this.", role: "body" },
    ]);
  });

  it("decorates known skill references that begin with a digit", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Use $2spec for this." }],
        },
      ],
    };

    expect(nativeMarkdownDocumentRuns(node, [{ name: "2spec", displayName: "2Spec" }])).toEqual([
      { text: "Use ", role: "body" },
      {
        text: "$2spec",
        role: "body",
        skillName: "2spec",
        skillLabel: "2Spec",
      },
      { text: " for this.", role: "body" },
    ]);
  });

  it("decorates known skill references inside blockquotes", () => {
    const node: MarkdownNode = {
      type: "blockquote",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Use $ui for this." }],
        },
      ],
    };

    expect(nativeMarkdownDocumentRuns(node, [{ name: "ui", displayName: "UI" }])).toContainEqual({
      text: "$ui",
      role: "body",
      skillName: "ui",
      skillLabel: "UI",
    });
  });

  it("leaves unknown skill-like text unchanged", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Use $unknown for this." }],
        },
      ],
    };

    expect(nativeMarkdownDocumentRuns(node, [])).toEqual([
      { text: "Use $unknown for this.", role: "body" },
    ]);
  });

  it("keeps headings, paragraphs, and lists in one continuous document", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "heading",
          level: 1,
          children: [{ type: "text", content: "Header One" }],
        },
        {
          type: "paragraph",
          children: [
            { type: "text", content: "A paragraph with " },
            { type: "bold", children: [{ type: "text", content: "bold text" }] },
            { type: "text", content: "." },
          ],
        },
        {
          type: "list",
          ordered: false,
          children: [
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "First item" }],
                },
              ],
            },
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Second item" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const runs = nativeMarkdownDocumentRuns(node);
    expect(runs.map((run) => run.text).join("")).toBe(
      "Header One\n\nA paragraph with bold text.\n\n•\tFirst item\n•\tSecond item",
    );
    expect(runs).toContainEqual({
      text: "Header One\n",
      role: "heading",
      headingLevel: 1,
    });
    expect(runs).toContainEqual({
      text: "bold text",
      bold: true,
      role: "body",
    });
    expect(runs).toContainEqual({
      text: "•\t",
      role: "list-marker",
      depth: 1,
      firstLineHeadIndent: 0,
      headIndent: 24,
      paragraphSpacing: 2,
    });
  });

  it("uses distinct section, heading-content, and body spacing", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Intro" }],
        },
        {
          type: "heading",
          level: 2,
          children: [{ type: "text", content: "Section" }],
        },
        {
          type: "paragraph",
          children: [{ type: "text", content: "First paragraph" }],
        },
        {
          type: "paragraph",
          children: [{ type: "text", content: "Second paragraph" }],
        },
      ],
    };

    expect(
      nativeMarkdownDocumentRuns(node)
        .filter((run) => run.role === "spacer")
        .map((run) => run.spacing),
    ).toEqual([20, 10, 12]);
  });

  it("renders tight list items whose inline nodes are direct children", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "list",
          children: [
            {
              type: "list_item",
              children: [
                {
                  type: "bold",
                  children: [{ type: "text", content: "Finding:" }],
                },
                { type: "text", content: " details with " },
                { type: "code_inline", content: "inline code" },
                { type: "text", content: "." },
              ],
            },
          ],
        },
      ],
    };

    expect(nativeMarkdownDocumentRuns(node)).toEqual([
      {
        text: "•\t",
        role: "list-marker",
        depth: 1,
        firstLineHeadIndent: 0,
        headIndent: 24,
        paragraphSpacing: 2,
      },
      { text: "Finding:", bold: true, role: "body", depth: 1 },
      { text: " details with ", role: "body", depth: 1 },
      { text: "inline code", code: true, role: "body", depth: 1 },
      { text: ".", role: "body", depth: 1 },
    ]);
  });

  it("preserves quotes and fenced code in document runs", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "blockquote",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", content: "Read this" }],
            },
          ],
        },
        {
          type: "code_block",
          language: "ts",
          content: "const answer = 42;",
        },
      ],
    };

    const runs = nativeMarkdownDocumentRuns(node);
    expect(runs.map((run) => run.text).join("")).toBe("│\u00a0Read this\n\nTS\nconst answer = 42;");
    expect(runs).toContainEqual({
      text: "const answer = 42;",
      code: true,
      role: "code-block",
    });
  });

  it("reads fenced code content from child text nodes", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "code_block",
          language: "bash",
          children: [{ type: "text", content: "pnpm install\n" }],
        },
      ],
    };

    expect(
      nativeMarkdownDocumentRuns(node)
        .map((run) => run.text)
        .join(""),
    ).toBe("BASH\npnpm install");
  });

  it("keeps adjacent context links with the same href in separate runs", () => {
    const href = "t3-context://v1/terminal/ctx-1";
    const link = (content: string): MarkdownNode => ({
      type: "link",
      href,
      children: [{ type: "text", content }],
    });
    const runs = nativeMarkdownDocumentRuns({
      type: "document",
      children: [{ type: "paragraph", children: [link("First"), link("Second")] }],
    });

    // Merging these would render one chip and emit one copy range with a
    // combined label for two distinct references.
    expect(runs).toEqual([
      { text: "First", role: "body", href, fileIcon: "bash" },
      { text: "Second", role: "body", href, fileIcon: "bash" },
    ]);
  });
});

describe("nativeMarkdownListItemBlocks", () => {
  it("groups consecutive inline nodes into one paragraph block", () => {
    const item: MarkdownNode = {
      type: "list_item",
      children: [
        { type: "text", content: "Finding: " },
        { type: "bold", children: [{ type: "text", content: "important" }] },
        { type: "text", content: " details." },
        {
          type: "list",
          children: [
            {
              type: "list_item",
              children: [{ type: "text", content: "Nested" }],
            },
          ],
        },
        { type: "text", content: "Trailing prose." },
      ],
    };

    expect(nativeMarkdownListItemBlocks(item)).toEqual([
      {
        type: "paragraph",
        children: item.children?.slice(0, 3),
      },
      item.children?.[3],
      {
        type: "paragraph",
        children: [item.children?.[4]],
      },
    ]);
  });
});

describe("nativeMarkdownDocumentChunks", () => {
  it("renders plain blockquotes as rich blocks so their marker spans wrapped lines", () => {
    const blockquote: MarkdownNode = {
      type: "blockquote",
      beg: 0,
      end: 120,
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              content:
                "Persistent random per-result keys are the strongest design, even when this text wraps.",
            },
          ],
        },
      ],
    };

    expect(
      nativeMarkdownDocumentChunks({
        type: "document",
        children: [blockquote],
      }),
    ).toEqual([
      {
        kind: "rich",
        key: "rich:blockquote:offset:0",
        node: blockquote,
      },
    ]);
  });

  it("keeps headings and plain lists in one selectable document", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "heading",
          level: 2,
          children: [{ type: "text", content: "Tasks" }],
        },
        {
          type: "list",
          children: [
            {
              type: "task_list_item",
              checked: true,
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Completed" }],
                },
              ],
            },
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Parent" }],
                },
                {
                  type: "list",
                  children: [
                    {
                      type: "list_item",
                      children: [
                        {
                          type: "paragraph",
                          children: [{ type: "text", content: "Nested" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: "selectable" });
    expect(
      nativeMarkdownDocumentRuns(chunks[0]?.node ?? document)
        .map((run) => run.text)
        .join(""),
    ).toBe("Tasks\n\n☑︎\tCompleted\n•\tParent\n◦\tNested");
  });

  it("aligns ordered markers while keeping the list in one selectable string", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "list",
          ordered: true,
          start: 9,
          children: [
            {
              type: "list_item",
              children: [{ type: "text", content: "Ninth" }],
            },
            {
              type: "list_item",
              children: [{ type: "text", content: "Tenth" }],
            },
          ],
        },
      ],
    };

    expect(
      nativeMarkdownDocumentRuns(document)
        .map((run) => run.text)
        .join(""),
    ).toBe("\u20079.\tNinth\n10.\tTenth");
  });

  it("keeps prose selectable while exposing rich AST blocks", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "heading",
          level: 1,
          beg: 0,
          end: 9,
          children: [{ type: "text", content: "Install" }],
        },
        {
          type: "code_block",
          language: "bash",
          beg: 11,
          end: 35,
          children: [{ type: "text", content: "pnpm install\n" }],
        },
        {
          type: "paragraph",
          beg: 37,
          end: 42,
          children: [{ type: "text", content: "Done." }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: "selectable" });
    expect(chunks[1]).toEqual({
      kind: "rich",
      key: "rich:code_block:offset:11",
      node: document.children?.[1],
    });
    expect(chunks[2]).toMatchObject({ kind: "selectable" });
  });

  it("keeps a list containing fenced code as one rich AST container", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "list",
          beg: 0,
          end: 45,
          children: [
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Install" }],
                },
                {
                  type: "code_block",
                  language: "bash",
                  children: [{ type: "text", content: "pnpm install\n" }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(nativeMarkdownDocumentChunks(document)).toEqual([
      {
        kind: "rich",
        key: "rich:list:offset:0",
        node: document.children?.[0],
      },
    ]);
  });

  it("keeps surrounding prose selectable when rich nodes have no source offsets", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "heading",
          level: 1,
          children: [{ type: "text", content: "Before" }],
        },
        { type: "horizontal_rule" },
        {
          type: "paragraph",
          children: [{ type: "text", content: "After." }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: "selectable" });
    expect(chunks[1]).toEqual({
      kind: "rich",
      key: "rich:horizontal_rule:index:1",
      node: document.children?.[1],
    });
    expect(chunks[2]).toMatchObject({ kind: "selectable" });
  });

  it("keeps offset-free structural lists isolated without promoting the whole document", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Before." }],
        },
        {
          type: "list",
          ordered: true,
          children: [
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Install" }],
                },
                {
                  type: "code_block",
                  language: "bash",
                  children: [{ type: "text", content: "pnpm install\n" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          children: [{ type: "text", content: "After." }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: "selectable" });
    expect(chunks[1]).toEqual({
      kind: "rich",
      key: "rich:list:index:1",
      node: document.children?.[1],
    });
    expect(chunks[2]).toMatchObject({ kind: "selectable" });
  });

  it("never collapses a rich subtree into a second markdown parsing pass", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Before." }],
        },
        {
          type: "blockquote",
          children: [
            {
              type: "list",
              children: [
                {
                  type: "list_item",
                  children: [
                    { type: "text", content: "Run this" },
                    {
                      type: "code_block",
                      language: "sh",
                      children: [{ type: "text", content: "vp check\n" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          children: [{ type: "text", content: "After." }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["selectable", "rich", "selectable"]);
    expect(chunks[1]).toMatchObject({
      kind: "rich",
      node: { type: "blockquote" },
    });
  });

  it("keys positioned and offset-free siblings in separate namespaces", () => {
    const positioned: MarkdownNode = {
      type: "blockquote",
      beg: 1,
      end: 10,
      children: [{ type: "paragraph", children: [{ type: "text", content: "Positioned" }] }],
    };
    const offsetFree: MarkdownNode = {
      type: "blockquote",
      children: [{ type: "paragraph", children: [{ type: "text", content: "Generated" }] }],
    };
    const chunks = nativeMarkdownDocumentChunks({
      type: "document",
      children: [
        { type: "paragraph", beg: 0, end: 0, children: [] },
        offsetFree,
        positioned,
        { type: "paragraph", children: [{ type: "text", content: "Tail" }] },
      ],
    });

    expect(chunks.map((chunk) => chunk.key)).toEqual([
      "selectable:offset:0",
      "rich:blockquote:index:1",
      "rich:blockquote:offset:1",
      "selectable:index:3",
    ]);
  });

  it("gives every offset-free selectable group its own key", () => {
    const chunks = nativeMarkdownDocumentChunks({
      type: "document",
      children: [
        { type: "paragraph", children: [{ type: "text", content: "One" }] },
        { type: "horizontal_rule" },
        { type: "paragraph", children: [{ type: "text", content: "Two" }] },
        { type: "horizontal_rule" },
        { type: "paragraph", children: [{ type: "text", content: "Three" }] },
      ],
    });

    expect(chunks.map((chunk) => chunk.key)).toEqual([
      "selectable:index:0",
      "rich:horizontal_rule:index:1",
      "selectable:index:2",
      "rich:horizontal_rule:index:3",
      "selectable:index:4",
    ]);
  });

  it("keeps positioned chunk keys stable while text streams in", () => {
    const before: MarkdownNode = {
      type: "document",
      children: [
        { type: "paragraph", beg: 0, end: 5, children: [{ type: "text", content: "Intro" }] },
        {
          type: "code_block",
          language: "ts",
          beg: 7,
          end: 20,
          children: [{ type: "text", content: "const a" }],
        },
      ],
    };
    const after: MarkdownNode = {
      type: "document",
      children: [
        { type: "paragraph", beg: 0, end: 5, children: [{ type: "text", content: "Intro" }] },
        {
          type: "code_block",
          language: "ts",
          beg: 7,
          end: 40,
          children: [{ type: "text", content: "const a = 1;\nconst b" }],
        },
      ],
    };

    expect(nativeMarkdownDocumentChunks(after).map((chunk) => chunk.key)).toEqual(
      nativeMarkdownDocumentChunks(before).map((chunk) => chunk.key),
    );
  });

  it("keeps a plain list in one selectable native text container", () => {
    const list: MarkdownNode = {
      type: "list",
      ordered: false,
      children: [
        {
          type: "list_item",
          children: [{ type: "text", content: "First" }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks({
      type: "document",
      children: [list],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      kind: "selectable",
      node: { type: "document", children: [list] },
    });
  });

  it("separates sections more than related rich blocks", () => {
    const headingChunk = {
      kind: "selectable" as const,
      key: "heading",
      node: {
        type: "document",
        children: [
          {
            type: "heading",
            level: 2,
            children: [{ type: "text", content: "Section" }],
          },
        ],
      } satisfies MarkdownNode,
    };
    const firstList = {
      kind: "rich" as const,
      key: "list-1",
      node: { type: "list", children: [] } satisfies MarkdownNode,
    };
    const secondList = {
      kind: "rich" as const,
      key: "list-2",
      node: { type: "list", children: [] } satisfies MarkdownNode,
    };

    expect(nativeMarkdownChunkSpacing(undefined, headingChunk)).toBe(0);
    expect(nativeMarkdownChunkSpacing(headingChunk, firstList)).toBe(10);
    expect(nativeMarkdownChunkSpacing(firstList, secondList)).toBe(12);
    expect(nativeMarkdownChunkSpacing(firstList, headingChunk)).toBe(20);
  });
});

describe("composerChipSizeSuffix", () => {
  it("labels attachment records with a human size, matching web's chip", async () => {
    const { composerChipSizeSuffix } = await import("@t3tools/mobile-markdown-text/markdown");
    expect(composerChipSizeSuffix({ kind: "file", sizeBytes: 1024 })).toBe("1 KB");
    expect(composerChipSizeSuffix({ kind: "file", sizeBytes: 3_700_000 })).toBe("3.5 MB");
    expect(composerChipSizeSuffix({ kind: "image", sizeBytes: 2048 })).toBe("2 KB");
  });

  it("adds nothing for records that carry no bytes", async () => {
    const { composerChipSizeSuffix } = await import("@t3tools/mobile-markdown-text/markdown");
    // Terminal/review/PR chips have no size to show.
    expect(composerChipSizeSuffix({ kind: "terminal" })).toBe("");
    expect(composerChipSizeSuffix({ kind: "file" })).toBe("");
    expect(composerChipSizeSuffix(undefined)).toBe("");
  });
});

describe("contextChipPresentation image detection", () => {
  it("treats a picture attached through the file picker as an image", async () => {
    const { contextChipPresentation } = await import("@t3tools/mobile-markdown-text/markdown");
    // The document picker types every pick as `file`, so the name has to carry the intent.
    expect(
      contextChipPresentation("file", { kind: "file", name: "IMG_4997.PNG", mimeType: "" }),
    ).toEqual({ accent: "#d55665", symbol: "photo" });
    expect(
      contextChipPresentation("file", {
        kind: "file",
        name: "shot",
        mimeType: "image/jpeg",
      }),
    ).toEqual({ accent: "#d55665", symbol: "photo" });
  });

  it("leaves genuine documents and videos alone", async () => {
    const { contextChipPresentation } = await import("@t3tools/mobile-markdown-text/markdown");
    expect(
      contextChipPresentation("file", { kind: "file", name: "notes.txt", mimeType: "text/plain" }),
    ).toEqual({ accent: "#0090cd", symbol: "doc" });
    expect(
      contextChipPresentation("file", { kind: "file", name: "clip.mp4", mimeType: "video/mp4" }),
    ).toEqual({ accent: "#d06217", symbol: "play.rectangle" });
  });
});

describe("pull request chip status", () => {
  const chip = async (state: string, isDraft = false) => {
    const { contextChipPresentation } = await import("@t3tools/mobile-markdown-text/markdown");
    return contextChipPresentation("review-comment", {
      kind: "review-comment",
      sectionId: "pull-request:10978",
      pullRequest: { state, isDraft },
    });
  };

  it("colours a pull request by its state, the way web and the forge do", async () => {
    expect((await chip("open")).accent).toBe("#009f6e");
    expect((await chip("open", true)).accent).toBe("#7f8793");
    expect((await chip("merged")).accent).toBe("#8a70dd");
    expect((await chip("closed")).accent).toBe("#d55665");
  });

  it("keeps one glyph across every state, so only colour carries the status", async () => {
    // Web draws a fixed `git-pull-request` and encodes state in colour alone. A per-state glyph
    // here would put mobile out of step with it.
    const symbols = await Promise.all(
      [chip("open"), chip("open", true), chip("merged"), chip("closed")].map(
        async (pending) => (await pending).symbol,
      ),
    );
    expect(new Set(symbols)).toEqual(new Set(["git-pull-request"]));
  });

  it("falls back to the generic pull request chip when the state is unknown", async () => {
    const { contextChipPresentation } = await import("@t3tools/mobile-markdown-text/markdown");
    // An older server may send no metadata at all; the chip still has to render.
    expect(
      contextChipPresentation("review-comment", {
        kind: "review-comment",
        sectionId: "pull-request:1",
      }).accent,
    ).toBe("#7079e4");
  });
});
