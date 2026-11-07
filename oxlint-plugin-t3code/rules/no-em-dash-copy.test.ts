import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-em-dash-copy", {
  filename: "apps/web/src/components/Example.tsx",
});

describe("t3code/no-em-dash-copy", () => {
  rule.valid(
    "allows em dashes in comments and regex literals",
    `
      // Parses titles like "Issue — Browser".
      const title = /^ [–—-] \\S/u;
    `,
  );

  rule.valid("allows hyphens and en dashes", `const label = "Refresh failed - retry 1–2";`);

  rule.invalid("reports a string literal", `const label = "Refresh failed — retry";`);

  rule.invalid("reports a template literal", "const label = `${name} — ${kind}`;");

  rule.invalid("reports JSX text", `const node = <p>Run a prompt — on an interval</p>;`);
});
