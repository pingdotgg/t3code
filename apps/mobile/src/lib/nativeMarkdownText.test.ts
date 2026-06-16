import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
  nativeMarkdownListItemBlocks,
  nativeMarkdownTextRuns,
} from "@t3tools/mobile-markdown-text/markdown";

describe("nativeMarkdownTextRuns", () => {
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
      { text: "README.md:12", fileIcon: "readme" },
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
  it("decorates known skill references as selectable skill chips", () => {
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

  it("includes quotes and fenced code in the same selectable string", () => {
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
      key: "rich:code_block:11:35",
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
        key: "rich:list:0:45",
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
      key: "rich:horizontal_rule:1:1",
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
      key: "rich:list:1:1",
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
