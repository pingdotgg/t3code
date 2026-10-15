import { describe, expect, it } from "@effect/vitest";
import { enrichedMarkdownWithMath } from "./enrichedMarkdownMath";

describe("native Enriched math input", () => {
  it.each(["- b", "+ c", "> d", "# e"])("keeps %s inside multiline display math", (line) => {
    expect(enrichedMarkdownWithMath(`$$\na \\\\\n${line}\n$$`)).toBe(`$$a \\\\ ${line}$$`);
    expect(enrichedMarkdownWithMath(`> $$\n> a \\\\\n> ${line}\n> $$`)).toBe(
      `> $$a \\\\ ${line}$$`,
    );
  });
  it("removes TeX comments before folding line breaks, preserving escaped percent signs", () => {
    expect(enrichedMarkdownWithMath("$$\nx% discarded\n+y \\% \\\\% discarded again\n+z\n$$")).toBe(
      "$$x+y \\% \\\\+z$$",
    );
  });
  it("normalizes complete math while retaining surrounding Markdown", () => {
    expect(
      enrichedMarkdownWithMath("**Inline** \\(x_i\\) and $y_i$.\n\n\\[x^2\\]\n\n```math\na+b\n```"),
    ).toBe("**Inline** $x_i$ and $y_i$.\n\n$$x^2$$\n\n$$a+b$$");
  });
  it("leaves prices, unmatched delimiters and citations visible", () => {
    expect(enrichedMarkdownWithMath("Price $5-$10, $unfinished, \\[1\\].")).toBe(
      "Price \\$5-\\$10, \\$unfinished, &#91;1&#93;.",
    );
  });
  it("shields numeric citations and unfinished bracket math from the native parser", () => {
    expect(enrichedMarkdownWithMath("Reference \\[1\\] and \\(unfinished")).toBe(
      "Reference &#91;1&#93; and &#40;unfinished",
    );
    expect(enrichedMarkdownWithMath("`\\[1\\]` and \\[x^2\\]")).toBe("`\\[1\\]` and $$x^2$$");
  });
  it("keeps prose delimiters from activating native math or reference links", () => {
    expect(enrichedMarkdownWithMath("Citation \\[1\\].\n\n[1]: https://example.test")).toBe(
      "Citation &#91;1&#93;.\n\n[1]: https://example.test",
    );
    expect(enrichedMarkdownWithMath("Literal \\) closer")).toBe("Literal &#41; closer");
  });
  it("keeps code, escaped dollars and destinations intact", () => {
    const source = "`$x$` \\$5 [site](https://example.com/$path)\n\n```js\nconst x = '$a$';\n```";
    expect(enrichedMarkdownWithMath(source)).toBe(source);
  });
  it("normalizes table math and retains raw pipes for the native parser", () => {
    expect(
      enrichedMarkdownWithMath(
        "| Name | Formula |\n|---|---|\n| Norm | \\(|x|\\) |\n| Escaped | $\\|y\\|$ |\n| Display | $$a+b$$ |",
      ),
    ).toBe(
      "| Name | Formula |\n|---|---|\n| Norm | $|x|$ |\n| Escaped | $|y|$ |\n| Display | $a+b$ |",
    );
  });
  it("keeps unfinished fences as code", () => {
    expect(enrichedMarkdownWithMath("```math\na+b")).toBe("```math\na+b");
  });
});
