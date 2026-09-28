import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-native-title-tooltip", {
  filename: "fixture.tsx",
});

describe("t3code/no-native-title-tooltip", () => {
  rule.valid(
    "allows intrinsic elements without a title attribute",
    `const el = <span className="truncate">Truncated text</span>;`,
  );

  rule.valid(
    "allows title props on custom components",
    `const el = <SettingsRow id="word-wrap" title="Word wrap" description="Wrap long lines." />;`,
  );

  rule.valid(
    "allows title on member expression components",
    `const el = <Foo.Bar title="Not a native tooltip" />;`,
  );

  rule.valid(
    "allows title as an accessible name on embedded content",
    `const el = <iframe title="Embedded widget" src="https://example.com" />;`,
  );

  rule.valid("allows the svg title child element", `const el = <svg><title>QR code</title></svg>;`);

  rule.valid("allows document.title assignments", `document.title = "Thread · T3 Code";`);

  rule.invalid(
    "reports title on a truncating span",
    `const el = <span className="min-w-0 truncate" title="Full repository name">Repo</span>;`,
    (output) => {
      assert.match(output, /native title attribute/);
    },
  );

  rule.invalid(
    "reports title on a button",
    `const el = <button type="button" aria-label="Scroll to end" title="Scroll to end" />;`,
    (output) => {
      assert.match(output, /Tooltip \+ TooltipTrigger \+ TooltipPopup/);
    },
  );
});
