import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-mobile-pull-request-glyph-literals", {
  filename: "apps/mobile/src/features/threads/PullRequestBadge.tsx",
});

describe("t3code/no-mobile-pull-request-glyph-literals", () => {
  rule.valid(
    "allows glyphs picked from the module",
    `
      import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

      const badge = <SymbolView name={merged ? PullRequestGlyph.merged : PullRequestGlyph.pullRequest} />;
    `,
  );

  rule.valid(
    "allows unrelated symbols and copy that mentions pull requests",
    `
      const branch = <SymbolView name="arrow.triangle.branch" />;
      const label = "Merge pull request";
    `,
  );

  rule.invalid(
    "reports a pull request glyph in a JSX attribute",
    `const badge = <SymbolView name="arrow.triangle.pull" />;`,
    (output) => {
      assert.match(output, /PullRequestGlyph/);
    },
  );

  rule.invalid(
    "reports state glyphs chosen inline",
    `const name = state === "closed" ? "git.pull-request.closed" : "git.pull-request.draft";`,
  );

  rule.invalid(
    "reports glyphs in platform symbol objects",
    `const icon = { ios: "arrow.triangle.merge", android: "merge" };`,
  );

  rule.invalid(
    "reports an Android-only pull request glyph",
    `const icon = { ios: "arrow.triangle.branch", android: "merge" };`,
  );

  rule.valid(
    "allows merge as an ordinary string outside an android symbol slot",
    `const action = { kind: "merge", label: "Merge" };`,
  );

  rule.valid(
    "allows merge in an android key outside a platform symbol object",
    `const command = { id: "pr.merge", android: "merge" };`,
  );

  rule.invalid(
    "reports an Android-only pull request glyph written as a template literal",
    'const icon = { ios: "arrow.triangle.branch", android: `merge` };',
  );

  rule.invalid("reports glyphs in template literals", "const name = `square.3.layers.3d`;");
});
