import { expect, it } from "vite-plus/test";

import { formulaMarkdown } from "./formulaText";

it.each<[string, string | null]>([
  ["Keep `__init__.py` and *.ts", null],
  ["Costs $5 or $6", null],
  ["```math\nx^2\n```", null],
  ["$\\frac{1}{2}$", "\\(\\frac{1}{2}\\)"],
  ["Half of $2$, **not** x$1$.", "Half of \\(2\\)\\, \\*\\*not\\*\\* x\\(1\\)\\."],
  [
    "1. [x](http://y) <b>&amp;</b> `$1$` \\$5 is $n_1$",
    "1\\. \\[x\\]\\(http\\:\\/\\/y\\) \\<b\\>\\&amp\\;\\<\\/b\\> \\`\\$1\\$\\` \\\\\\$5 is \\(n_1\\)",
  ],
  ["  $a$\n\n - b $$x$$", "&#32;&#32;\\(a\\)\n\n&#32;\\- b \\(x\\)"],
])("typesets a label's formulas and escapes its other text: %j", (text, expected) => {
  expect(formulaMarkdown(text)).toBe(expected);
});
