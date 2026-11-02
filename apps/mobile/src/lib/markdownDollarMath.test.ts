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
});
