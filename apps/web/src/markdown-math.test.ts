import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { describe, expect, it } from "vite-plus/test";

import { normalizeLatexMathDelimiters } from "./markdown-math";

describe("normalizeLatexMathDelimiters", () => {
  it("renders normalized delimiters through KaTeX", () => {
    const html = renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex] },
        normalizeLatexMathDelimiters("Euler: \\(e^{i\\pi} + 1 = 0\\)"),
      ),
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain("mathml");
  });

  it("rewrites paired inline and display delimiters", () => {
    expect(normalizeLatexMathDelimiters("inline \\(a+b\\)\n\n\\[\nE=mc^2\n\\]")).toBe(
      "inline $ a+b $\n\n$$\nE=mc^2\n$$",
    );
  });

  it("preserves source length and task-list offsets", () => {
    const source = "- [ ] task with \\(a+b\\) inline";
    const normalized = normalizeLatexMathDelimiters(source);
    expect(normalized).toHaveLength(source.length);
    expect(normalized.indexOf("[ ]")).toBe(source.indexOf("[ ]"));
  });

  it("leaves unmatched and escaped delimiters unchanged", () => {
    expect(
      normalizeLatexMathDelimiters("\\(open only and a stray \\] plus \\\\(literal\\\\)"),
    ).toBe("\\(open only and a stray \\] plus \\\\(literal\\\\)");
  });

  it("leaves inline, fenced, quoted fenced, and indented code unchanged", () => {
    const source = [
      "`\\(inline\\)`",
      "```md",
      "\\(fenced\\)",
      "```",
      "> ~~~",
      "> \\(quoted\\)",
      "> ~~~",
      "    \\(indented\\)",
      "prose \\(math\\)",
    ].join("\n");
    expect(normalizeLatexMathDelimiters(source)).toBe(
      source.replace("prose \\(math\\)", "prose $ math $"),
    );
  });

  it("leaves link destinations, autolinks, and HTML attributes unchanged", () => {
    const source = [
      "[file](file:///tmp/foo\\(bar\\).ts)",
      "<https://example.com/foo\\(bar\\)>",
      '<span title="\\(attribute\\)">text</span>',
      "[label \\(x\\)](https://example.com)",
    ].join("\n");
    expect(normalizeLatexMathDelimiters(source)).toBe(
      source.replace("label \\(x\\)", "label $ x $"),
    );
  });

  it("does not pair delimiters across separate text nodes", () => {
    const source = "\\(open **bold** close\\)";
    expect(normalizeLatexMathDelimiters(source)).toBe(source);
  });

  it("leaves unrelated escapes and dollar amounts unchanged", () => {
    const source = "just \\* escapes, \\_underscores\\_ and $5 dollars";
    expect(normalizeLatexMathDelimiters(source)).toBe(source);
  });
});
