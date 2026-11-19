import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/no-runtime-typeof");

const reported = [
  [
    "a typeof comparison",
    'export const isText = (value: string | number) => typeof value === "string";',
  ],
  [
    "a typeof branch",
    'export function f(value: string | number) { if (typeof value === "number") return 1; return 0; }',
  ],
];

const allowed = [
  [
    "a discriminant comparison",
    'export const isText = (value: { kind: "text" | "number" }) => value.kind === "text";',
  ],
  ["a type-level typeof", "const base = { a: 1 };\nexport type Base = typeof base;"],
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
