import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-type-classes", {
  filename: "fixture.tsx",
});

describe("t3code/no-raw-type-classes", () => {
  rule.valid(
    "allows the type roles",
    `const el = <span className="text-meta text-dim-foreground" />;`,
  );

  rule.valid(
    "allows text colors, alignment and wrapping",
    `const el = <p className="text-center text-balance text-muted-foreground truncate" />;`,
  );

  rule.valid(
    "allows the Text component",
    `const el = <Text variant="label" tone="muted">Hi</Text>;`,
  );

  rule.invalid(
    "reports a Tailwind size and weight",
    `const el = <span className="text-sm font-medium text-foreground" />;`,
    (output) => {
      assert.match(output, /Raw type classes \(text-sm font-medium\)/);
      assert.match(output, /<Text variant>/);
    },
  );

  rule.invalid(
    "reports arbitrary sizes and the old small steps",
    `const a = "text-[13px]"; const b = "text-2xs";`,
    (output) => {
      assert.match(output, /text-\[13px\]/);
      assert.match(output, /text-2xs/);
    },
  );

  rule.invalid(
    "reports sizes behind variants and in class constants",
    `export const ROW_CLASS = "h-7 sm:text-sm hover:font-semibold";`,
    (output) => {
      assert.match(output, /sm:text-sm hover:font-semibold/);
    },
  );
});

const ceiling = createOxlintRuleHarness("t3code/no-raw-type-classes", {
  filename: "fixture.tsx",
  ruleOptions: [{ maxOccurrences: 1 }],
});

describe("t3code/no-raw-type-classes maxOccurrences", () => {
  ceiling.valid("allows a file's existing debt up to its ceiling", `const a = "text-xs";`);

  ceiling.invalid(
    "reports raw type beyond the ceiling",
    `const a = "text-xs"; const b = "font-medium";`,
    (output) => {
      assert.match(output, /Raw type classes \(font-medium\)/);
    },
  );
});
