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
});
