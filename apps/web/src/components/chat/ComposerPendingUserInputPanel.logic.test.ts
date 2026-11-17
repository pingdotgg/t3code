import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import { VFile } from "vfile";
import { expect, it } from "vite-plus/test";

import { remarkOptionText } from "./ComposerPendingUserInputPanel.logic";

it.each<[string, Array<[string, string]>]>([
  ["$\\frac{1}{2}$", [["inlineMath", "\\frac{1}{2}"]]],
  [
    "Half of $2$, **not** $1$.",
    [
      ["text", "Half of "],
      ["inlineMath", "2"],
      ["text", ", **not** "],
      ["inlineMath", "1"],
      ["text", "."],
    ],
  ],
  ["1. Keep `__init__.py` and *.ts", [["text", "1. Keep `__init__.py` and *.ts"]]],
  ["# <b>[x](y)</b> `$1$` \\$5", [["text", "# <b>[x](y)</b> `$1$` \\$5"]]],
  [
    "> $$\n> x^2\n> $$\n> done",
    [
      ["text", "> "],
      ["inlineMath", "x^2"],
      ["text", "\n> done"],
    ],
  ],
])("typesets an option's formulas and leaves its other text as written: %j", (source, expected) => {
  const tree = parseMarkdownWithMath(source);
  remarkOptionText()(tree, new VFile(source));
  expect(tree.children.map((node) => [node.type, "value" in node ? node.value : null])).toEqual(
    expected,
  );
});
