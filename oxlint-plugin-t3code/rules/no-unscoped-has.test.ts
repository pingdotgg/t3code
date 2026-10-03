/* oxlint-disable t3code/no-unscoped-has -- the fixtures are invalid on purpose */
import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-unscoped-has", {
  filename: "fixture.tsx",
});

describe("t3code/no-unscoped-has", () => {
  rule.valid(
    "allows :has() on the element itself",
    `const className = "[&:has([data-slot=icon])]:ps-2";`,
  );

  rule.valid(
    "allows :has() anchored to an attribute",
    `const className = "[&+[data-chat-composer-form]:has(>[data-slot=banner])]:mt-0";`,
  );

  rule.valid(
    "allows :has() inside :not() on the element itself",
    `const className = "[&:not(:has(+[data-slot=footer]))]:rounded-b-2xl";`,
  );

  rule.valid(
    "allows built-in has-* variants",
    `const className = "has-[>[data-slot=icon]]:ps-2 group-has-[:checked]:opacity-100";`,
  );

  rule.valid(
    "allows a sibling selector without :has()",
    `const className = "[&+*_[data-chat-composer-form]>[data-slot=attachment]]:before:rounded-none";`,
  );

  rule.valid("ignores prose mentioning :has()", `const note = "uses :has( for styling";`);

  rule.valid(
    "ignores :has() inside an arbitrary value",
    `const className = "before:content-[':has(foo)']";`,
  );

  rule.valid(
    "allows a negated :has() on the element itself",
    `const className = "[&:not(.collapsed):not(:has(>[data-slot=icon]))]:ps-2";`,
  );

  rule.valid(
    "allows :has() on a group or peer element",
    `const className = "group-[:has(input)]:p-2 peer-[:has(input)]:p-2 group-[&:has(input)]/row:p-2";`,
  );

  rule.valid(
    "allows a selector list whose own branch is anchored",
    `const className = "[:is(.a,.b):has(x)_&]:p-2 [&:not(.a,:has(x))]:p-2";`,
  );

  rule.valid(
    "ignores :has() text in quoted attribute values",
    `const className = "data-[foo='_:has(x)']:p-2 [&_[data-query='_:has(foo)']]:p-2";`,
  );

  rule.valid(
    "allows a selector without & on the element itself",
    `const className = "[:has(>input)]:p-2 not-[:has(>[data-slot=icon])]:ps-2";`,
  );

  rule.invalid(
    "reports a sibling :has() with nothing anchoring it",
    `const className = "[&+:has([data-chat-composer-form])_[data-chat-composer-form]]:before:rounded-none";`,
    (output) => {
      assert.match(output, /Anchor the :has\(\)/);
    },
  );

  rule.invalid(
    "reports a descendant :has() with nothing anchoring it",
    `const className = cn("p-2", "[&_:has(>input)]:gap-1");`,
  );

  rule.invalid(
    "reports a universal :has() ancestor",
    "const className = `flex [*:has([data-open])_&]:hidden`;",
  );

  rule.invalid(
    "reports :has() whose only anchor is negated",
    `const className = "[*:not(.safe):has([data-open])_&]:hidden";`,
  );

  rule.invalid("reports uppercase :HAS()", `const className = "[*:HAS([data-open])_&]:hidden";`);

  rule.invalid(
    "reports a selector-list branch borrowing another branch's anchor",
    `const className = "[.safe,:has(input)_&]:p-2";`,
  );

  rule.invalid(
    "reports an unanchored branch inside :is()",
    `const className = "[&_:is(.safe,:has(input))]:p-2";`,
  );

  rule.invalid(
    "reports an unanchored :has() inside a named group variant",
    `const className = "group-[&_:has(x)]/row:p-2";`,
  );

  rule.invalid(
    "reports a :has() on an ancestor of a selector without &",
    `const className = "[:has(x)_.foo]:p-2";`,
  );

  rule.invalid(
    "reports a :has() on an ancestor of a group",
    `const className = "group-[:has(x)_.y]:p-2";`,
  );

  rule.invalid("reports an in-* ancestor :has()", `const className = "in-[:has(x)]:p-2";`);

  rule.invalid(
    "reports :has() anchored to the document root",
    `const className = "[body:has([data-dialog-open])_&]:overflow-hidden";`,
  );
});
