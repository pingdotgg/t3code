import { describe, expect, it } from "vite-plus/test";
import { normalizeLatexDelimiters } from "./markdown-latex";

describe("normalizeLatexDelimiters", () => {
  it("normalizes parenthesis and bracket delimiters without shifting source offsets", () => {
    const markdown = "Inline \\(x\\)\n\\[\ny\n\\]\n- [ ] task";
    const normalized = normalizeLatexDelimiters(markdown);

    expect(normalized).toBe("Inline $$x$$\n$$\ny\n$$\n- [ ] task");
    expect(normalized).toHaveLength(markdown.length);
  });

  it("leaves escaped delimiters and code unchanged", () => {
    const markdown = [
      String.raw`Literal \\(x\\) and \[math\].`,
      "Inline code: `\\(code\\)`.",
      "",
      "~~~text",
      String.raw`\[fenced\]`,
      "~~~",
      String.raw`    \(indented\)`,
    ].join("\n");

    expect(normalizeLatexDelimiters(markdown)).toBe(
      markdown.replace(String.raw`\[math\]`, () => "$$math$$"),
    );
  });
});
