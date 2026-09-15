import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-hermes-unsupported-apis", {
  filename: "fixture.ts",
});

describe("t3code/no-hermes-unsupported-apis", () => {
  rule.valid("allows in-place sort on a copy", `const sorted = [...items].sort(compare);`);

  rule.valid("allows in-place reverse on a copy", `const reversed = [...items].reverse();`);

  rule.valid(
    "allows other ES2023 methods Hermes ships",
    `const last = items.findLast(Boolean); const tail = items.at(-1);`,
  );

  rule.valid(
    "ignores property reads that are not calls",
    `const hasToSorted = typeof Array.prototype.toSorted === "function";`,
  );

  rule.invalid("reports toSorted", `const sorted = items.toSorted(compare);`, (output) => {
    assert.match(output, /Array#toSorted/);
  });

  rule.invalid(
    "reports toReversed in a chain",
    `const open = chains.map((chain) => chain.layers.toReversed().filter(isOpen));`,
    (output) => {
      assert.match(output, /Array#toReversed/);
    },
  );

  rule.invalid(
    "reports toSpliced via computed access with a copy-then-splice remediation",
    `const next = items["toSpliced"](0, 1);`,
    (output) => {
      assert.match(output, /Array#toSpliced/);
      assert.match(output, /const copy = \[\.\.\.array\]; copy\.splice\(\.\.\.\); use copy/);
    },
  );

  rule.invalid(
    "reports a static template-literal property name",
    "const reversed = items[`toReversed`]();",
    (output) => {
      assert.match(output, /Array#toReversed/);
    },
  );

  rule.valid(
    "ignores a template-literal property with substitutions",
    "const value = items[`to${suffix}`]();",
  );

  rule.valid("allows supported Intl constructors", `new Intl.NumberFormat();`);
  rule.valid("allows feature detection", `const supported = typeof Intl.Segmenter === "function";`);
  rule.valid("allows unrelated Segmenter constructors", `new custom.Segmenter();`);
  rule.valid("ignores dynamic computed names", `new Intl[Segmenter](); items[toSorted]();`);

  for (const expression of [
    "new Intl.Segmenter(undefined, { granularity: 'grapheme' })",
    "new Intl['Segmenter']()",
    "new Intl[`Segmenter`]()",
    "new globalThis.Intl.Segmenter()",
    "new globalThis['Intl']['Segmenter']()",
    "new global.Intl.Segmenter()",
    "new window.Intl.Segmenter()",
    "Intl.Segmenter()",
    "Intl.Segmenter?.()",
  ]) {
    rule.invalid(`reports ${expression}`, `${expression};`, (output) => {
      assert.match(output, /Hermes does not implement Intl\.Segmenter/);
      assert.match(output, /portable implementation/);
    });
  }
});
