import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import ChatMarkdown, { orderedListGutterStyle } from "./ChatMarkdown";

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
  });
});

describe("LaTeX / Math rendering in ChatMarkdown", () => {
  it("renders inline math with KaTeX markup", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown text={String.raw`The formula is \(E = mc^2\) in physics.`} cwd={undefined} />,
    );
    expect(html).toContain("katex");
    expect(html).toContain("katex-html");
    expect(html).toContain("E");
  });

  it("renders repeated inline LaTeX delimiters in prose", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`Imaginary numbers begin with \(i=\sqrt{-1}\), so \(i^2=-1\). You can calculate with \(i\) like any other number, while replacing \(i^2\) with \(-1\).`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex");
    expect(html.match(/class="katex"/g)).toHaveLength(5);
    expect(html).toContain("i=\\sqrt{-1}");
    expect(html).toContain("i^2=-1");
  });

  it("renders block display math with KaTeX markup", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`Here is a display equation:

$$
\\frac{a}{b} = c
$$`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-display");
    expect(html).toContain("katex-html");
  });

  it("renders math when sanitized raw HTML parsing is enabled", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`<span>Formula:</span> \(x^2\)`}
        cwd={undefined}
        parseRawHtml
      />,
    );
    expect(html).toContain("katex-html");
  });

  it("renders LaTeX bracket notations \\[ ... \\] and \\( ... \\)", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`For example:

\\[
\\frac{1+i}{2+i}
\\]

and inline \\(2-i\\)`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-display");
    expect(html).toContain("katex-html");
    expect(html).toContain("1+i");
    expect(html).toContain("2-i");
  });

  it("does not mutate brackets inside code blocks", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`\`\`\`ts
const x = "\\[ \\frac{a}{b} \\]";
\`\`\``}
        cwd={undefined}
      />,
    );
    expect(html).toContain("\\[ \\frac{a}{b} \\]");
  });

  it.each([
    "~~~ts\nconst x = \\\\(notMath\\\\);\n~~~",
    "    const x = \\\\(notMath\\\\);",
    "Use ``\\(notMath\\)`` here.",
  ])("does not mutate math delimiters in another code form", (text) => {
    const html = renderToStaticMarkup(<ChatMarkdown text={text} cwd={undefined} />);
    expect(html).toContain("notMath");
    expect(html).not.toContain("katex");
  });

  it("leaves paired currency amounts intact without triggering math rendering", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown text="It costs $5 today and $10 tomorrow." cwd={undefined} />,
    );
    expect(html).toContain("$5 today and $10 tomorrow.");
    expect(html).not.toContain("katex");
  });

  it.each([
    ["blockquotes", "> Quote: \\(E = mc^2\\)", "katex"],
    ["display math in blockquotes", "> \\[\n> E = mc^2\n> \\]", "katex-display"],
    ["list items", "- Item with \\(x + y\\)", "katex"],
    ["display math in list items", "- Item:\n  \\[\n  x = 1\n  \\]", "katex-display"],
    ["emphasis", "**Bold \\(x^2\\)** and *italic \\(y^2\\)*", "katex"],
    ["links", "[Formula \\(x^2\\)](https://example.com)", "katex"],
    ["tables", "| Formula |\n| --- |\n| \\(x^2 + y^2\\) |", "katex"],
    ["footnotes", "Formula[^1]\n\n[^1]: Here is \\(x^2\\)", "katex"],
  ])("renders math nested inside %s", (_container, markdown, expectedClass) => {
    const html = renderToStaticMarkup(<ChatMarkdown text={markdown} cwd={undefined} />);
    expect(html).toContain(expectedClass);
    expect(html).toContain("katex-html");
  });

  it("renders multiline aligned equations and cases with row breaks in display math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`\[
\begin{aligned}
f(x) &= x^2 + 2x + 1 \\
&= (x + 1)^2
\end{aligned}
\]`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-display");
    expect(html).toContain("aligned");
    expect(html).not.toContain("KaTeX parse error");
  });

  it("handles formulas with nested parentheses and brackets without delimiter truncation", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`Inline \(\frac{(a+b)}{(c+d)}\) and display \[\sqrt[3]{(x+y)^2}\] in one go.`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-html");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("KaTeX parse error");
  });

  it("renders formulas containing markdown-sensitive characters like underscores and asterisks", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`Values \(x_1 + x_2 + x_3\) and product \(a * b * c\).`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-html");
    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).not.toContain("KaTeX parse error");
  });

  it("renders multiple display equations interspersed with text in a single block", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`First equation: \\[ E = mc^2 \\] and second equation: \\[ F = ma \\] with conclusion.`}
        cwd={undefined}
      />,
    );
    const displayMatches = html.match(/class="katex-display"/g);
    expect(displayMatches).toHaveLength(2);
    expect(html).toContain("First equation:");
    expect(html).toContain("and second equation:");
    expect(html).toContain("with conclusion.");
  });

  it("leaves unclosed delimiters as literal text without crashing or rendering invalid math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`This has an unclosed delimiter \( x^2 + y^2 and continues as text.`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("This has an unclosed delimiter ( x^2 + y^2 and continues as text.");
    expect(html).not.toContain("katex-error");
  });

  it("does not treat plain bracketed text or array indexing as math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`Check array element arr[i] and pattern [a-z0-9] here.

[
TODO: do not convert this plain bracketed text
]`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("arr[i]");
    expect(html).toContain("TODO: do not convert this plain bracketed text");
    expect(html).not.toContain("katex");
  });

  it("handles empty math delimiters gracefully", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`Empty inline \(\) and empty display \[\] here.`}
        cwd={undefined}
      />,
    );
    expect(html).not.toContain("KaTeX parse error");
  });

  it("renders complex nested structures with both inline and display math in blockquotes and lists", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`> Quote starting with inline \(a=1\):
> \[
> \begin{pmatrix} 1 & 0 \\ 0 & 1 \end{pmatrix}
> \]
> and ending with \(b=2\).

1. List item 1 with \(x_i\):
   \[
   y_i = x_i^2 + 1
   \]
2. List item 2 with \(\sum_{k=1}^n k\)`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-display");
    expect(html).toContain("katex-html");
    expect(html).not.toContain("KaTeX parse error");
  });

  it("renders complex calculus, limits, summations, and vectors without errors", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`Integral: \(\int_{0}^{\pi} \sin(x)\,dx = 2\).
Display limit:
\[
\lim_{x \to 0} \frac{\sin x}{x} = 1
\]
Sum: \(\sum_{n=1}^\infty \frac{1}{n^2} = \frac{\pi^2}{6}\).
Vectors: \(\mathbf{v} \cdot \mathbf{w} = \|\mathbf{v}\| \|\mathbf{w}\| \cos\theta\).
Big-O: \(\mathcal{O}(n \log n)\).`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-display");
    expect(html.match(/class="katex"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("KaTeX parse error");
  });

  it("leaves standard backslashes in prose untouched without false math triggering", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`Windows path: C:\\Users\\user\\Desktop\\file.txt
Escape sequences: \\n, \\t, \\r in descriptions.
Regex patterns: \\d+ and \\w+ matching.
Trailing slash at end of sentence \\`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("C:\\Users\\user\\Desktop\\file.txt");
    expect(html).toContain("\\n, \\t, \\r");
    expect(html).toContain("\\d+ and \\w+");
    expect(html).not.toContain("katex");
  });

  it("correctly handles interleaved inline code and math on the same line", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text="Define `x = 2` then compute \(f(x) = x^2\) which returns `4`."
        cwd={undefined}
      />,
    );
    expect(html).toContain("x = 2");
    expect(html).toContain("data-inline-code");
    expect(html).toContain("katex-html");
    expect(html).toContain("f(x)");
  });

  it("renders math inside GFM task list items", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`- [x] Done: compute \\(x_1 + x_2\\)
- [ ] Todo: verify display \\[ E = mc^2 \\]`}
        cwd={undefined}
      />,
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("katex-html");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("KaTeX parse error");
  });

  it("strips blockquote continuation markers from display math without rendering stray > relation", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`> \\[
> E = mc^2
> \\]`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-display");
    expect(html).toContain('<annotation encoding="application/x-tex">E = mc^2</annotation>');
    expect(html).not.toContain("&gt;");
    expect(html).not.toContain("KaTeX parse error");
  });

  it("renders display math inside mixed-phrasing paragraphs alongside emphasis and links", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`**Note:** \\[ E = mc^2 \\] and see [formula link](https://example.com) for details.`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("<strong>Note:</strong>");
    expect(html).toContain("katex-display");
    expect(html).toContain("E = mc^2");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("\\[");
    expect(html).not.toContain("\\]");
  });

  it("preserves markdown escape resolutions in text adjacent to math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`Costs \$100 for \(x^2\) with \*not italic\* and \_not underline\_.`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("Costs $100 for");
    expect(html).toContain("katex-html");
    expect(html).toContain("with *not italic* and _not underline_.");
    expect(html).not.toContain("\\$");
    expect(html).not.toContain("\\*");
    expect(html).not.toContain("\\_");
  });

  it("preserves valid > operators in display math outside blockquotes", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`\\[
a > b
\\]`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-display");
    expect(html).toContain("&gt;");
    expect(html).toContain("a");
    expect(html).toContain("b");
    expect(html).not.toContain("KaTeX parse error");
  });

  it("preserves valid > operators in display math inside blockquotes after stripping quote prefix", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`> \\[
> a > b
> \\]`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("katex-display");
    expect(html).toContain("&gt;");
    expect(html).toContain("a");
    expect(html).toContain("b");
    expect(html).not.toContain("KaTeX parse error");
  });

  it("does not produce block display math elements inside inline containers like strong or links", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text="**Result: \\[x^2\\]** and [Formula \\[x^2\\]](https://example.com)"
        cwd={undefined}
      />,
    );
    expect(html).toContain("<strong>Result:");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("katex-display");
  });

  it("does not render escaped literal delimiters as math when adjacent to real math in a paragraph", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`Here is escaped \\(literal\\) and real \(x^2\) math.`}
        cwd={undefined}
      />,
    );
    expect(html).toContain(String.raw`\(literal\)`);
    expect(html).not.toContain('<annotation encoding="application/x-tex">literal</annotation>');
    expect(html).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
  });

  it("decodes HTML character references in text adjacent to math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`AT&amp;T \(x\) with &copy; 2026 and &#38; / &#x26; symbol.`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("AT&amp;T");
    expect(html).not.toContain("&amp;amp;");
    expect(html).toContain("© 2026");
    expect(html).not.toContain("&amp;copy;");
    expect(html).toContain("&amp; / &amp; symbol.");
    expect(html).not.toContain("&#38;");
    expect(html).not.toContain("&#x26;");
  });

  it("strips blockquote continuation markers from prose surrounding inline math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`> Text \\(x\\) and more
> next line`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("<blockquote>");
    expect(html).toContain("katex-html");
    expect(html).toContain("and more\nnext line");
    expect(html).not.toContain("&gt;");
  });

  it("strips blockquote continuation markers from prose surrounding display math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`> Text before
> \\[ E = mc^2 \\]
> text after
> next line`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("<blockquote>");
    expect(html).toContain("katex-display");
    expect(html).toContain("text after\nnext line");
    expect(html).not.toContain("&gt;");
  });

  it("renders complex multi-line blockquote with inline math, display math, prose, and character entities without corruption", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`> AT&amp;T &copy; 2026 with \\(x_1 + x_2\\) equation
> continuation line before display math
> \\[ \\frac{a}{b} = c \\]
> and final prose with &quot;quoted&quot; text on line 4.`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("<blockquote>");
    expect(html).toContain("AT&amp;T");
    expect(html).toContain("© 2026");
    expect(html).toContain("katex-html");
    expect(html).toContain("katex-display");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain("continuation line before display math");
    expect(html).toContain("and final prose with");
    expect(html).not.toContain("&gt;");
    expect(html).not.toContain("&amp;amp;");
    expect(html).not.toContain("&amp;copy;");
    expect(html).not.toContain("&amp;quot;");
  });

  it("handles multi-line inline backticks and tilde code fences without corrupting math or dollar signs", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={`Here is \`inline code
with \\(x\\) and $100
inside\` and a fence:
~~~bash
echo "$HOME and $100 and \\[x\\]"
~~~
and real math \\(y^2\\).`}
        cwd={undefined}
      />,
    );
    expect(html).toContain("with \\(x\\) and $100");
    expect(html).toContain("echo &quot;$HOME and $100 and \\[x\\]&quot;");
    expect(html).toContain("katex-html");
    expect(html).toContain('<annotation encoding="application/x-tex">y^2</annotation>');
  });

  it("correctly handles backslash parity (odd vs even backslashes) before math delimiters and dollar signs", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text={String.raw`Even backslashes \\(literal\\) and odd \\\(x^2\) and escaped backslash before dollar \\$100.`}
        cwd={undefined}
      />,
    );
    // Even backslash \\( remains literal \(literal\)
    expect(html).toContain(String.raw`\(literal\)`);
    expect(html).not.toContain('<annotation encoding="application/x-tex">literal</annotation>');
    // Odd backslashes \\\( renders literal \ plus math for \(x^2\)
    expect(html).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
    // \\$100 renders as \$100
    expect(html).toContain("$100");
  });

  it("preserves shell variables and multiple ambient dollar signs without triggering false math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text="Set $HOME and $PATH with $1 or $? where price is $50, discounted from $100 (savings $50) for \(x^2\)."
        cwd={undefined}
      />,
    );
    expect(html).toContain("$HOME");
    expect(html).toContain("$PATH");
    expect(html).toContain("$1");
    expect(html).toContain("$?");
    expect(html).toContain("$50");
    expect(html).toContain("$100");
    expect(html).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
  });

  it("handles empty inline and display delimiters gracefully without crashing or invalid display math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text="Empty inline \(\) and empty display \[\] adjacent to real \(x^2\)."
        cwd={undefined}
      />,
    );
    expect(html).toContain("Empty inline");
    expect(html).toContain("empty display");
    expect(html).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
    expect(html).not.toContain("KaTeX parse error");
  });
});
