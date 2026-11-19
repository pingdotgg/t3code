import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/no-widen-then-assert");

const reported = [
  [
    "an unknown binding later asserted",
    "export function f() {\n  const value: unknown = { id: 1 };\n  return value as { id: number };\n}",
  ],
  [
    "a known value widened to object and asserted back",
    "const known = { id: 1 };\nconst wide: object = known;\nexport const row = wide as { id: number };",
  ],
];

const allowed = [
  ["a precise binding", 'export function f() {\n  const mode = "fast";\n  return mode;\n}'],
  [
    "an assertion on a parsed value",
    "export function f(input: string) {\n  const mode: string = input;\n  return mode.length;\n}",
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
