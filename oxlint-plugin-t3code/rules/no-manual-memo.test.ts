import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-manual-memo", {
  filename: "fixture.tsx",
});

describe("t3code/no-manual-memo", () => {
  rule.valid("allows plain derived values", `const total = items.length * 2;`);

  rule.valid("allows useStableCallback", `const onClick = useStableCallback(() => save());`);

  rule.valid("allows other React members", `const ref = React.useRef(null);`);

  rule.valid("allows other directives", `function Panel() { "use client"; return null; }`);

  rule.invalid(
    'reports a "use memo" directive',
    `function useTotal(items) { "use memo"; return items.length; }`,
  );

  rule.invalid("reports useMemo", `const total = useMemo(() => items.length, [items]);`);

  rule.invalid("reports useCallback", `const onClick = useCallback(() => save(), []);`);

  rule.invalid(
    "reports React.useMemo",
    `const total = React.useMemo(() => items.length, [items]);`,
  );

  rule.invalid('reports "use no memo"', `function Panel() { "use no memo"; return null; }`);

  rule.invalid('reports a module-level "use no forget"', `"use no forget";\nexport const a = 1;`);

  rule.valid("allows the same text as a string value", `const label = "use no memo";`);
});

const ratchet = createOxlintRuleHarness("t3code/no-manual-memo", {
  filename: "fixture.tsx",
  ruleOptions: [{ allowMemoHooks: true }],
});

describe("t3code/no-manual-memo with allowMemoHooks", () => {
  ratchet.valid("allows useMemo", `const total = useMemo(() => items.length, [items]);`);

  ratchet.valid("allows useCallback", `const onClick = useCallback(() => save(), []);`);

  ratchet.invalid(
    'still reports "use no memo"',
    `function Panel() { "use no memo"; return null; }`,
  );
});
