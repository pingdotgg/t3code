import { describe, expect, it } from "vite-plus/test";
import { unified } from "unified";
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";

import { remarkChatMath } from "./markdownMath.ts";

const mathPlugins = [...CHAT_MARKDOWN_REMARK_PLUGINS, remarkChatMath];
const mathPluginsWithBreaks = [...CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS, remarkChatMath];

describe("chat math parsing", () => {
  it.each(["$$\nx^2", "> $$\n> x^2\n\noutside", "- $$\n  x^2\n\noutside"])(
    "keeps an unfinished dollar block literal: %s",
    (source) => {
      const processor = unified().use(remarkParse).use(mathPlugins);
      const tree = processor.runSync(processor.parse(source)) as Root;
      expect(JSON.stringify(tree)).not.toContain('"type":"math"');
      expect(JSON.stringify(tree)).not.toContain('"type":"inlineMath"');
    },
  );

  it("keeps single-dollar text and links intact", () => {
    const processor = unified().use(remarkParse).use(mathPlugins);
    const tree = processor.runSync(
      processor.parse("Use $TOKEN, then [docs](/users?$select=id)."),
    ) as Root;
    expect(tree.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "Use $TOKEN, then " },
        { type: "link", url: "/users?$select=id" },
        { type: "text", value: "." },
      ],
    });
  });
  it.each([[mathPlugins], [mathPluginsWithBreaks]])(
    "preserves matrix row separators and source positions",
    (plugins) => {
      const processor = unified().use(remarkParse).use(plugins);
      const source = String.raw`Before \(
B=\begin{pmatrix}3&8&1\\-2&6&4\end{pmatrix}
\) after`;
      const tree = processor.runSync(processor.parse(source)) as Root;
      const paragraph = tree.children[0];
      expect(paragraph?.type).toBe("paragraph");
      if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
      const math = paragraph.children[1];
      expect(math).toMatchObject({
        type: "inlineMath",
        value: "\nB=\\begin{pmatrix}3&8&1\\\\-2&6&4\\end{pmatrix}\n",
      });
      expect(source.slice(math?.position?.start.offset, math?.position?.end.offset)).toBe(
        source.slice(7, -6),
      );
    },
  );

  it("marks backslash display math without changing ordinary Markdown escapes", () => {
    const processor = unified().use(remarkParse).use(mathPlugins);
    const source = String.raw`\[x_{12}\] and \[literal bracket and \(x\)`;
    const tree = processor.runSync(processor.parse(source)) as Root;
    expect(tree.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        {
          type: "inlineMath",
          value: "x_{12}",
          data: { hProperties: { className: ["language-math", "math-display"] } },
        },
        { type: "text", value: " and [literal bracket and " },
        { type: "inlineMath", value: "x" },
      ],
    });
  });

  it("keeps code examples, escaped delimiters, and unfinished math literal", () => {
    const processor = unified().use(remarkParse).use(mathPlugins);
    const source =
      "Inline: `\\(x\\) $x$`" +
      String.raw`

~~~tex
\[x\]
~~~

Escaped \\(x\\), price \$5, unfinished \(x`;
    const tree = processor.runSync(processor.parse(source)) as Root;
    expect(JSON.stringify(tree)).not.toContain('"type":"inlineMath"');
    expect(JSON.stringify(tree)).not.toContain('"type":"math"');
    expect(tree.children[1]).toMatchObject({ type: "code", value: "\\[x\\]" });
  });

  it("preserves skill mentions and prices that use single dollars", () => {
    const processor = unified().use(remarkParse).use(mathPlugins);
    const tree = processor.runSync(
      processor.parse("Use $2spec with a $20k budget; $5 or $10."),
    ) as Root;
    expect(tree.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "Use $2spec with a $20k budget; $5 or $10." }],
    });
  });
});
