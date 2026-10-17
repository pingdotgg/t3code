import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-memo-directives", {
  filename: "fixture.tsx",
});

describe("t3code/no-memo-directives", () => {
  rule.valid("allows other directives", `function Panel() { "use client"; return null; }`);

  rule.valid("allows the same text as a string value", `const label = "use no memo";`);

  rule.invalid(
    'reports "use memo"',
    `function useTotal(items) { "use memo"; return items.length; }`,
  );

  rule.invalid('reports "use no memo"', `function Panel() { "use no memo"; return null; }`);

  rule.invalid('reports a module-level "use no memo"', `"use no memo";\nexport const a = 1;`);
});
