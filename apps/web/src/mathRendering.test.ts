import { describe, expect, it } from "vite-plus/test";
import { renderMathHtml } from "./mathRendering";

describe("math rendering", () => {
  it.each([
    String.raw`$x_i^2 + \alpha$`,
    String.raw`\(\frac{a}{b}\)`,
    String.raw`\[\sum_{i=1}^n x_i\]`,
    String.raw`$$\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}$$`,
    String.raw`$$\begin{aligned}x &= 1 \\ y &= 2\end{aligned}$$`,
  ])("renders accessible math for %s", (source) => {
    const html = renderMathHtml(source);
    expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"');
    expect(html).toContain('encoding="application/x-tex"');
    expect(html).not.toContain("katex-error");
  });

  it.each([String.raw`$\frac{$`, String.raw`$\unsupportedCommand{x}$`, String.raw`$\def\a{\a}\a$`])(
    "falls back locally for malformed or unbounded input %s",
    (source) => {
      expect(renderMathHtml(source)).toBeNull();
      expect(renderMathHtml("$x$")).toContain("<math");
    },
  );

  it("does not allow TeX to introduce active HTML", () => {
    const html = renderMathHtml(String.raw`$\href{javascript:alert(1)}{click}$`);
    expect(html ?? "").not.toContain("href=");
    expect(renderMathHtml(String.raw`$\htmlClass{bad}{x}$`)).toBeNull();
  });

  it("does not share macro definitions between equations", () => {
    renderMathHtml(String.raw`$\gdef\privateMacro{x}\privateMacro$`);
    expect(renderMathHtml(String.raw`$\privateMacro$`)).toBeNull();
  });
});
