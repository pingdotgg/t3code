import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/no-chained-type-assertions");

const reported = [
  ["a double assertion through unknown", "export const a = (value as unknown) as string;"],
  ["a parenthesized chain", "export const a = ((value as Base) as Derived);"],
  ["an angle-bracket chain", "export const a = <Derived>(<Base>value);"],
];

const allowed = [
  ["a single assertion", "export const a = value as string;"],
  ["a const assertion chain", 'export const a = (["x"] as const) as const;'],
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
