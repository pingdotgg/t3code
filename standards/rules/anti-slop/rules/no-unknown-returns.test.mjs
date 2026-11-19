import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/no-unknown-returns");

const reported = [
  ["a function returning unknown", "export function f(): unknown { return 1; }"],
  [
    "an async function returning Promise<unknown>",
    "export async function f(): Promise<unknown> { return 1; }",
  ],
  ["an arrow function returning unknown", "export const f = (): unknown => 1;"],
];

const allowed = [
  ["a named return type", "export function f(): number { return 1; }"],
  ["an inferred return type", "export function f() { return 1; }"],
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
