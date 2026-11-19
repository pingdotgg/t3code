import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/no-known-value-widening");

const reported = [
  [
    "a literal object annotated as a string dictionary of unknown",
    "export const a: Record<string, unknown> = { id: 1 };",
  ],
  ["a literal array annotated as unknown", "export const a: unknown = [1, 2];"],
  ["a literal object annotated as object", "export const a: object = { id: 1 };"],
];

const allowed = [
  ["a literal with inference", "export const a = { id: 1 };"],
  [
    "a literal checked with satisfies",
    "export const a = { id: 1 } satisfies Record<string, number>;",
  ],
  [
    "a literal with a named contract",
    "interface Row { id: number }\nexport const a: Row = { id: 1 };",
  ],
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
