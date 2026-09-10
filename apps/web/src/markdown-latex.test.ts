import { describe, expect, it } from "vite-plus/test";
import { normalizeLatexDelimiters } from "./markdown-latex";

describe("normalizeLatexDelimiters", () => {
  it("normalizes parenthesis and bracket delimiters without shifting source offsets", () => {
    const markdown = "Inline \\(x\\)\n\\[\ny\n\\]\n- [ ] task";
    const normalized = normalizeLatexDelimiters(markdown);

    expect(normalized).toBe("Inline $$x$$\n\n\n$$\ny\n$$\n\n\n- [ ] task");
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
      markdown.replace(String.raw`\[math\]`, () => "\n\n$$math$$\n\n"),
    );
  });

  it("handles CR-only fences and container-prefixed code", () => {
    const markdown = "```text\r\\(fenced\\)\r```\r\r>     \\(quoted code\\)\r\rAfter \\(x\\)";
    expect(normalizeLatexDelimiters(markdown)).toBe(
      markdown.replace(String.raw`\(x\)`, () => "$$x$$"),
    );
  });

  it("does not normalize raw HTML code elements or malformed fences", () => {
    const markdown = "<pre>\\(raw\\)</pre>\n```text `\n\\(not fenced\\)\nAfter \\(x\\)";
    expect(normalizeLatexDelimiters(markdown)).toBe(
      "<pre>\\(raw\\)</pre>\n```text `\n$$not fenced$$\nAfter $$x$$",
    );
  });

  it("does not let an unmatched inline code opener hide later math", () => {
    expect(normalizeLatexDelimiters("` unmatched\nLater \\(x\\)")).toBe("` unmatched\nLater $$x$$");
  });
});
