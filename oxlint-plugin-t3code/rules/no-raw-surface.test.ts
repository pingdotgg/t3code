import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-surface", {
  filename: "fixture.tsx",
});

describe("t3code/no-raw-surface", () => {
  rule.valid(
    "allows surfaces, radius tokens and divider hairlines",
    `const el = <div className="surface-card rounded-card border-t border-divider rounded-t-pane" />;`,
  );

  rule.valid(
    "allows full, none, inherited and var-based radii, transparent borders and shadow tokens",
    `const el = <div className="rounded-full rounded-none rounded-[inherit] rounded-[var(--control-radius)] border border-transparent shadow-dialog shadow-none" />;`,
  );

  rule.valid(
    "allows solid status fills and text colors",
    `const el = <span className="bg-success text-muted-foreground hover:surface-ghost-hover" />;`,
  );

  rule.invalid(
    "reports a hand-built card and names the replacements",
    `const el = <div className="rounded-lg border border-border bg-card shadow-sm" />;`,
    (output) => {
      assert.match(output, /Hand-built surface \(rounded-lg border-border bg-card shadow-sm\)/);
      assert.match(output, /surface-card/);
      assert.match(output, /rounded-card/);
      assert.match(output, /docs\/internals\/web-ui\.md#surfaces/);
    },
  );

  rule.invalid(
    "reports tints, side radii, arbitrary values and variant prefixes",
    `const a = "hover:bg-foreground/5"; const b = "rounded-t-md"; const c = "rounded-[6px] shadow-[0_1px_2px_black]"; const d = "data-faded:border-border/50";`,
    (output) => {
      assert.match(output, /hover:bg-foreground\/5/);
      assert.match(output, /surface-tint/);
      assert.match(output, /rounded-t-md/);
      assert.match(output, /rounded-\[6px\] shadow-\[0_1px_2px_black\]/);
      assert.match(output, /data-faded:border-border\/50/);
    },
  );

  rule.invalid(
    "reports surfaces in class constants and cva variants",
    `const TONE = { warning: "bg-warning/10 text-warning" }; const v = cva("", { variants: { variant: { node: \`bg-popover \${x}\` } } });`,
    (output) => {
      assert.match(output, /bg-warning\/10/);
      assert.match(output, /bg-popover/);
    },
  );
});

const ceiling = createOxlintRuleHarness("t3code/no-raw-surface", {
  filename: "fixture.tsx",
  ruleOptions: [{ maxOccurrences: 1 }],
});

describe("t3code/no-raw-surface maxOccurrences", () => {
  ceiling.valid("allows a file's existing debt up to its ceiling", `const a = "bg-muted";`);

  ceiling.invalid(
    "reports surfaces beyond the ceiling",
    `const a = "bg-muted"; const b = "rounded-md";`,
    (output) => {
      assert.match(output, /Hand-built surface \(rounded-md\)/);
    },
  );

  ceiling.invalid(
    "reports a ceiling above the file's count",
    `const a = "surface-card rounded-card";`,
    (output) => assert.match(output, /Debt ceiling 1, file has 0: lower it to 0/),
  );
});

// Inside components/ui the two rules work together: no-raw-surface counts a feature's raw look
// moved into a variant, and no-new-ui-variants names any variant the table does not list.
const variants = createOxlintRuleHarness("t3code/no-new-ui-variants", {
  filename: "button.tsx",
  ruleOptions: [{ allowed: ["buttonVariants.size.sm", "buttonVariants.variant.ghost"] }],
});

describe("t3code/no-new-ui-variants", () => {
  variants.valid(
    "allows the listed variants",
    `const buttonVariants = cva("", { variants: { size: { sm: "h-7" }, variant: { ghost: "" } } });`,
  );

  variants.invalid(
    "reports a variant the table does not list",
    `const buttonVariants = cva("", { variants: { size: { sm: "h-7" }, variant: { ghost: "", "fleet-node": "surface-raised" } } });`,
    (output) => {
      assert.match(output, /New components\/ui variant "buttonVariants\.variant\.fleet-node"/);
      assert.match(output, /stays in that feature's component/);
    },
  );

  variants.invalid(
    "reports listed variants that are gone",
    `const buttonVariants = cva("", { variants: { size: { sm: "h-7" } } });`,
    (output) => {
      assert.match(output, /no longer exist: buttonVariants\.variant\.ghost\. Run/);
    },
  );
});
