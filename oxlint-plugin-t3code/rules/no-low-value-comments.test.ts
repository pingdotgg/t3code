import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-low-value-comments");

describe("t3code/no-low-value-comments", () => {
  rule.valid(
    "allows prose that ends in a three-character token",
    `
      // Both sides compare with ===
      export const same = (a: unknown, b: unknown) => a === b;
      // YAML front matter closes with ---
      export const frontMatter = "---";
    `,
  );

  rule.invalid(
    "reports a label padded with a divider run",
    "// Helpers ----\nexport const value = 1;\n",
    (output) => {
      assert.match(output, /Drop the section divider/);
    },
  );
});
