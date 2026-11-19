import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/no-unsafe-dictionary-type");

const reported = [
  ["a Record of unknown", "export type Bag = Record<string, unknown>;"],
  ["a Record of any", "export type Bag = Record<string, any>;"],
  ["an index signature of unknown", "export interface Bag { [key: string]: unknown }"],
  ["a Record of object", "export type Bag = Record<string, object>;"],
];

const allowed = [
  ["a Record of a concrete type", "export type Bag = Record<string, number>;"],
  [
    "an index signature of a named type",
    "interface Row { id: string }\nexport interface Rows { [key: string]: Row }",
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
