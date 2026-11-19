import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/require-safety-comment-for-type-assertion");

const reported = [
  ["an assertion without a comment", "export const a = value as string;"],
  ["an assertion with an unrelated comment", "// convert it\nexport const a = value as string;"],
];

const allowed = [
  [
    "an assertion with a SAFETY comment",
    "// SAFETY: value was checked by the caller\nconst a = value as string;\nvoid a;",
  ],
  ["a const assertion", 'export const a = ["x"] as const;'],
];

for (const [name, source] of reported) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports a finding`, () => {
    NodeAssert.ok(lint(source).length > 0);
  });
}

for (const [name, source] of allowed) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports nothing`, () => {
    NodeAssert.deepEqual(lint(source), []);
  });
}
