import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-registered-list-scroll", {
  filename: "fixture.tsx",
});

describe("t3code/require-registered-list-scroll", () => {
  rule.valid(
    "allows a list that renders through a registered scroll view",
    `const el = <LegendList data={rows} renderScrollComponent={NativeScrollView} />;`,
  );

  rule.valid(
    "allows a keyboard-aware list with its scroll view component",
    `const el = <KeyboardAwareLegendList data={rows} ScrollViewComponent={FeedScrollView} />;`,
  );

  rule.invalid(
    "reports a list given the other list's scroll prop",
    `const el = <LegendList data={rows} ScrollViewComponent={NativeScrollView} />;`,
  );

  rule.invalid(
    "reports a list with the default scroll view",
    `const el = <AnimatedLegendList data={rows} renderItem={renderRow} />;`,
    (output) => {
      assert.match(output, /header-registered scroll view/);
    },
  );
});
