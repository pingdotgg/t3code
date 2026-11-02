import { describe, expect, it } from "vite-plus/test";
import { markdownWithDollarMath } from "./markdownDocument";

describe("backslash math delimiters", () => {
  it("rewrites \\(…\\) and \\[…\\] to the dollar delimiters md4c typesets", () => {
    const reply = [
      String.raw`\[A=\begin{pmatrix}1&1\\0&1\end{pmatrix}\]`,
      "",
      String.raw`\[\det(A-\lambda I)=0\]`,
      "",
      String.raw`Inline: the eigenvalue \(\lambda = 1\) has multiplicity two, and \(A^{-1}=\frac{1}{\det A}\begin{pmatrix}1&-1\\0&1\end{pmatrix}\).`,
      "",
      String.raw`Dollar form for comparison: $$\det(A-\lambda I)=(1-\lambda)^2$$ and $x^2$.`,
    ].join("\n");

    expect(markdownWithDollarMath(reply)).toBe(
      [
        String.raw`$$A=\begin{pmatrix}1&1\\0&1\end{pmatrix}$$`,
        "",
        String.raw`$$\det(A-\lambda I)=0$$`,
        "",
        String.raw`Inline: the eigenvalue $\lambda = 1$ has multiplicity two, and $A^{-1}=\frac{1}{\det A}\begin{pmatrix}1&-1\\0&1\end{pmatrix}$.`,
        "",
        String.raw`Dollar form for comparison: $$\det(A-\lambda I)=(1-\lambda)^2$$ and $x^2$.`,
      ].join("\n"),
    );
  });
  it("leaves code, escaped parentheses and bracket citations as authored", () => {
    const reply = [
      "Call `f\\(x\\)` or write \\\\(x\\\\); see \\[1\\] and \\[2\\].",
      "",
      "```tex",
      String.raw`\(x\) and \[y\]`,
      "```",
    ].join("\n");

    expect(markdownWithDollarMath(reply)).toBe(reply);
  });

  it("leaves formulas whose dollar delimiters md4c would not open, close or keep apart", () => {
    for (const reply of [
      String.raw`the \(n\)th term`,
      String.raw`函数\(f(x)\)的值`,
      String.raw`\(a\)\(b\)`,
      String.raw`Before \(x\)$y$ after.`,
    ]) {
      expect(markdownWithDollarMath(reply)).toBe(reply);
    }
  });

  it("converts back-to-back display formulas on consecutive lines", () => {
    expect(markdownWithDollarMath(String.raw`\[a\]` + "\n" + String.raw`\[b\]`)).toBe(
      "$$a$$\n$$b$$",
    );
  });

  it("converts a long reply full of closed formulas", () => {
    const line = (i: number, open: string, close: string) =>
      `The term ${open}x_${i}^2 + 2 x_${i} + 1${close} is non-negative.`;
    const reply = Array.from({ length: 390 }, (_, i) => line(i, "\\(", "\\)")).join("\n");

    expect(markdownWithDollarMath(reply)).toBe(
      Array.from({ length: 390 }, (_, i) => line(i, "$", "$")).join("\n"),
    );
  });

  it("keeps container prefixes inside a multi-line formula", () => {
    expect(markdownWithDollarMath(String.raw`> \[` + "\n> a+b\n> " + String.raw`\]`)).toBe(
      "> $$\n> a+b\n> $$",
    );
  });
});
