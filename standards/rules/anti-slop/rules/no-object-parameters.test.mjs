import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/no-object-parameters");

const reported = [
  [
    "a function with an object parameter",
    "export function load(input: object): void { void input; }",
  ],
  [
    "an arrow function with an object parameter",
    "export const load = (input: object): void => { void input; };",
  ],
  [
    "a method with an aliased object parameter",
    "type Anything = object;\nexport class Loader { load(input: Anything): void { void input; } }",
  ],
];

const allowed = [
  [
    "a named parameter type",
    "interface Query { id: string }\nexport function load(input: Query): void { void input; }",
  ],
  ["a primitive parameter", "export function load(id: string): void { void id; }"],
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
