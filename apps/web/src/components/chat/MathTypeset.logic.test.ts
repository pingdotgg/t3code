import katex from "katex";
import { describe, expect, it } from "vite-plus/test";

import { escapeLiteralPercents } from "./MathTypeset.logic";

describe("escapeLiteralPercents", () => {
  it.each([
    ["\\text{3.18% yield}", "\\text{3.18\\% yield}"],
    ["\\text{100%% yield}", "\\text{100\\%\\% yield}"],
    ["6\\% + 2\\%", "6\\% + 2\\%"],
    ["x\\\\%", "x\\\\\\%"],
    ["x % note\n+ 1", "x % note\n+ 1"],
    ["% note\n\\text{2%}", "% note\n\\text{2\\%}"],
    ["x &= 1 % +9%\n\\text{2%}", "x &= 1 % +9%\n\\text{2\\%}"],
    ["\\verb|50%|+\\text{2%}", "\\verb|50%|+\\text{2\\%}"],
    ["\\verb*%a%b%+c%", "\\verb*%a%b\\%+c\\%"],
    ["\\verb|50%+\\text{2%}", "\\verb|50%+\\text{2%}"],
  ])("repairs %j", (tex, expected) => {
    expect(escapeLiteralPercents(tex)).toBe(expected);
  });

  it("lets the reported multiline equation typeset", () => {
    const tex =
      "R_e=\\underbrace{\\frac{1.0176}{32}}_{\\text{3.18% dividend yield}}\n+\\underbrace{6\\%}_{\\text{growth}}\n=\\boxed{9.18\\%}";
    expect(() => katex.renderToString(tex, { throwOnError: true })).toThrow();
    expect(() =>
      katex.renderToString(escapeLiteralPercents(tex), { throwOnError: true }),
    ).not.toThrow();
  });
});
