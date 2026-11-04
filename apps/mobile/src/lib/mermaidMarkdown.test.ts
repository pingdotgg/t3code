import { describe, expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";

import { splitMermaidMarkdown } from "./mermaidMarkdown";

describe("splitMermaidMarkdown", () => {
  it("splits a closed mermaid fence between markdown", () => {
    const markdown = "Here is the flow:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nDone.";
    expect(splitMermaidMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown: "Here is the flow:\n\n", sourceOffset: 0 },
      {
        kind: "mermaid",
        source: "flowchart TD\n  A --> B\n",
        markdown: "```mermaid\nflowchart TD\n  A --> B\n```",
        sourceOffset: 19,
      },
      { kind: "markdown", markdown: "\nDone.", sourceOffset: 57 },
    ]);
  });

  it("keeps an unclosed streaming fence as markdown", () => {
    const markdown = "Flow:\n```mermaid\nflowchart TD\n  A --> B";
    expect(splitMermaidMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("ignores mermaid fences nested in other fences or indented", () => {
    const markdown =
      "````md\n```mermaid\ngraph LR\n```\n````\n\n- item\n  ```mermaid\n  graph LR\n  ```";
    expect(splitMermaidMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("keeps Mermaid examples inside indented outer fences as code", () => {
    const markdown = "   ````markdown\n```mermaid\ngraph LR\nA --> B\n```\n   ````";
    expect(splitMermaidMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("accepts an indented closing fence", () => {
    const markdown = "```mermaid\ngraph LR\nA --> B\n   ```";
    expect(splitMermaidMarkdown(markdown)[0]?.kind).toBe("mermaid");
  });

  it("preserves Unicode line separators inside a fence info string", () => {
    const markdown =
      "mermaid\n" + "````".repeat(3000) + "\u2028x\n```mermaid\ngraph LR\nA --> B\n```";
    expect(splitMermaidMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("keeps document reference definitions available on both sides of a diagram", () => {
    const markdown =
      "[docs][ref]\n\n```mermaid\ngraph LR\nA --> B\n```\n\n[ref]: https://example.com\n![diagram][ref]";
    const segments = splitMermaidMarkdown(markdown);
    const text = segments.filter((segment) => segment.kind === "markdown");
    expect(text).toHaveLength(2);
    const parser = unified().use(remarkParse);
    const first = parser
      .parse(text[0]?.markdown ?? "")
      .children.find((node) => node.type === "paragraph");
    const last = parser
      .parse(text[1]?.markdown ?? "")
      .children.find((node) => node.type === "paragraph");
    expect(first?.type === "paragraph" && first.children[0]?.type).toBe("linkReference");
    expect(last?.type === "paragraph" && last.children[0]?.type).toBe("imageReference");
  });

  it("keeps an image reference nested in a link reference resolvable after a diagram", () => {
    const markdown =
      "[img]: https://example.com/a.png\n\n```mermaid\ngraph LR\nA --> B\n```\n\n[![alt][img]][link]\n\n[link]: https://example.com";
    const last = splitMermaidMarkdown(markdown).at(-1);
    const paragraph = unified()
      .use(remarkParse)
      .parse(last?.markdown ?? "")
      .children.find((node) => node.type === "paragraph");
    const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
    expect(link?.type === "linkReference" && link.children[0]?.type).toBe("imageReference");
  });

  it("does not let a fence line inside raw HTML swallow a later diagram", () => {
    const segments = splitMermaidMarkdown(
      "<div>\n```js\n</div>\n\n```mermaid\ngraph TD\nA-->B\n```\n",
    );
    expect(segments.find((segment) => segment.kind === "mermaid")).toMatchObject({
      source: "graph TD\nA-->B\n",
      sourceOffset: 20,
    });
  });

  it.each([
    "<!--\n```mermaid\ngraph LR\nA --- B\n```\n-->",
    "<pre>\n```mermaid\ngraph LR\nA --- B\n```\n</pre>",
  ])("keeps fences inside raw HTML in their original markdown context", (markdown) => {
    expect(splitMermaidMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("does not close a fence on non-ASCII whitespace", () => {
    const markdown = "```mermaid\ngraph LR\n```\u00a0\nA-->B\n```\nafter";
    expect(
      splitMermaidMarkdown(markdown).find((segment) => segment.kind === "mermaid"),
    ).toMatchObject({
      source: "graph LR\n```\u00a0\nA-->B\n",
    });
  });

  it("splits tilde fences and closes on a longer fence", () => {
    const segments = splitMermaidMarkdown("~~~ Mermaid\ngraph LR\n~~~~\n");
    expect(segments).toEqual([
      {
        kind: "mermaid",
        source: "graph LR\n",
        markdown: "~~~ Mermaid\ngraph LR\n~~~~",
        sourceOffset: 0,
      },
    ]);
  });

  it("keeps offsets aligned after a leading byte order mark", () => {
    const markdown = "﻿```mermaid\ngraph TD\nA-->B\n```\nafter";
    expect(splitMermaidMarkdown(markdown)).toEqual([
      {
        kind: "mermaid",
        source: "graph TD\nA-->B\n",
        markdown: "```mermaid\ngraph TD\nA-->B\n```",
        sourceOffset: 1,
      },
      { kind: "markdown", markdown: "after", sourceOffset: 31 },
    ]);
  });

  it("keeps an unclosed fence after a byte order mark as markdown", () => {
    const markdown = "﻿```mermaid\ngraph TD\nA-->B\nB-->C\n";
    expect(splitMermaidMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it.each([
    ["> [r]:\n>   https://example.com\n", "https://example.com", null],
    [
      '> [r]: https://example.com\n> "A \\"quoted\\" title"\n',
      "https://example.com",
      'A "quoted" title',
    ],
    ["[r]: <a\\<b\\>c\\\\d&#10;e&amp;amp;f>\n", "a<b>c\\d\ne&amp;f", null],
    ['[r]: /u "x&#10;&#10;y\\\\"\n', "/u", "x\n\ny\\"],
  ])("carries a %j definition as a standalone definition", (definition, url, title) => {
    const markdown = `${definition}\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\`\n\n[Guide][r]`;
    const last = splitMermaidMarkdown(markdown).at(-1);
    const tree = unified()
      .use(remarkParse)
      .parse(last?.markdown ?? "");
    expect(tree.children.map((node) => node.type)).toEqual(["definition", "paragraph"]);
    expect(tree.children[0]).toMatchObject({ identifier: "r", url, title });
    const paragraph = tree.children[1];
    expect(paragraph?.type === "paragraph" && paragraph.children[0]).toMatchObject({
      type: "linkReference",
      identifier: "r",
    });
  });

  it.each(["a\\[b", "x\\]y", "a\\\\b", "AT&amp;T", "> q"])(
    "keeps the %j reference label resolvable after a diagram",
    (label) => {
      const markdown = `[${label}]: https://example.com\n\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\`\n\n[Guide][${label}]`;
      const last = splitMermaidMarkdown(markdown).at(-1);
      const tree = unified()
        .use(remarkParse)
        .parse(last?.markdown ?? "");
      const [definition, paragraph] = tree.children;
      expect(definition).toMatchObject({ type: "definition", url: "https://example.com" });
      expect(paragraph?.type === "paragraph" && paragraph.children[0]).toMatchObject({
        type: "linkReference",
        identifier: definition?.type === "definition" ? definition.identifier : undefined,
      });
    },
  );

  it("splits a fence whose info string spells mermaid with a character reference", () => {
    expect(splitMermaidMarkdown("```&#109;ermaid\ngraph TD\n```")[0]?.kind).toBe("mermaid");
  });
});
