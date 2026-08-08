import { describe, expect, it } from "vite-plus/test";

import { normalizeLatexMathDelimiters } from "./markdown-math";

describe("normalizeLatexMathDelimiters", () => {
  it("rewrites inline delimiters into remark-math delimiters", () => {
    expect(normalizeLatexMathDelimiters("text \\(a^2 + b^2\\) end")).toBe("text $ a^2 + b^2 $ end");
  });

  it("rewrites display delimiters into remark-math delimiters", () => {
    expect(normalizeLatexMathDelimiters("\\[\nE = mc^2\n\\]")).toBe("$$\nE = mc^2\n$$");
  });

  it("preserves source length so mdast offsets stay valid", () => {
    const source = [
      "- \\(\\cos(E_q(q), E_d(d))\\)",
      "- \\(\\log(1 + e^{s_{ik} - s_{ij}})\\)",
      "- \\(A_t = \\lambda_t A_t^{\\text{local}}\\)",
    ].join("\n");
    expect(normalizeLatexMathDelimiters(source)).toHaveLength(source.length);
  });

  it("keeps task list markers at the same offsets", () => {
    const source = "- [ ] task with \\(a+b\\) inline";
    const normalized = normalizeLatexMathDelimiters(source);
    expect(normalized.indexOf("[ ]")).toBe(source.indexOf("[ ]"));
  });

  it("leaves delimiters inside inline code spans untouched", () => {
    expect(normalizeLatexMathDelimiters("`\\(x\\)` and \\(y\\)")).toBe("`\\(x\\)` and $ y $");
  });

  it("leaves delimiters inside fenced code blocks untouched", () => {
    expect(normalizeLatexMathDelimiters("```\n\\(x\\)\n```\n\\(y\\)")).toBe(
      "```\n\\(x\\)\n```\n$ y $",
    );
  });

  it("leaves tilde fenced code blocks untouched", () => {
    expect(normalizeLatexMathDelimiters("~~~\n\\(x\\)\n~~~\n\\(y\\)")).toBe(
      "~~~\n\\(x\\)\n~~~\n$ y $",
    );
  });

  it("does not touch other escapes or dollar amounts", () => {
    const source = "just \\* escapes, \\_underscores\\_ and $5 dollars";
    expect(normalizeLatexMathDelimiters(source)).toBe(source);
  });

  it("returns the input unchanged when there is no latex math", () => {
    const source = "plain **markdown** with a [link](https://example.com)";
    expect(normalizeLatexMathDelimiters(source)).toBe(source);
  });

  it("does not treat an escaped backslash as a delimiter", () => {
    expect(normalizeLatexMathDelimiters("a \\\\(not math\\\\) b")).toBe("a \\\\(not math\\\\) b");
  });
});
