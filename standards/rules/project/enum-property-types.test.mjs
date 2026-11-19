import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../lint-fixture.mjs";

const lint = createRuleFixture("project/prefer-enum-property-types", [
  { properties: { runtimeMode: { types: ["RuntimeMode"], hint: "Use RuntimeMode." } } },
]);

const reported = [
  ["a string property type", "export interface Thread { runtimeMode: string }"],
  ["an optional string property type", "export interface Thread { runtimeMode?: string }"],
  ["a string class field", 'export class Thread { runtimeMode: string = "full-access"; }'],
  ["a zod string schema", "export const schema = z.object({ runtimeMode: z.string() });"],
];

const allowed = [
  ["the enum-backed type", "export interface Thread { runtimeMode: RuntimeMode }"],
  ["a nullable enum-backed type", "export interface Thread { runtimeMode: RuntimeMode | null }"],
  ["an unconfigured string property", "export interface Thread { title: string }"],
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
