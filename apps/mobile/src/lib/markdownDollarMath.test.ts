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

  it("leaves replies whose literal dollars md4c would pair with an inserted one", () => {
    for (const reply of [
      String.raw`It costs $5. The formula is \(\frac{1}{2}\).`,
      String.raw`Set $HOME. Then \(\lambda=1\).`,
      String.raw`Invalid \(a $b\) here.`,
    ]) {
      expect(markdownWithDollarMath(reply)).toBe(reply);
    }
  });

  it("leaves replies the shared parser would reread or cannot walk", () => {
    const formula = String.raw`\(x\)` + "\n\n";
    for (const reply of [
      formula + (String.raw`\[` + "\n\n").repeat(300),
      formula + (String.raw`\(` + "x".repeat(60) + "\n").repeat(80) + "`" + String.raw`\)`,
      "- ".repeat(2996) + String.raw`\(x\)`,
    ]) {
      expect(markdownWithDollarMath(reply)).toBe(reply);
    }
  });

  it("keeps container prefixes inside a multi-line formula", () => {
    expect(markdownWithDollarMath(String.raw`> \[` + "\n> a+b\n> " + String.raw`\]`)).toBe(
      "> $$\n> a+b\n> $$",
    );
  });
});
