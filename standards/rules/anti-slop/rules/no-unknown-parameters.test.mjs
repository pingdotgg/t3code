import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/no-unknown-parameters");

const reported = [
  [
    "a function with an unknown parameter",
    "export function f(value: unknown): void { void value; }",
  ],
  [
    "an arrow function with an unknown parameter",
    "export const f = (value: unknown): void => { void value; };",
  ],
  [
    "a method with an unknown parameter",
    "export class A { run(value: unknown): void { void value; } }",
  ],
  [
    "an interface method with an unknown parameter",
    "export interface A { run(value: unknown): void }",
  ],
];

const allowed = [
  ["a named parameter type", "export function f(value: string): void { void value; }"],
  [
    "an error cause",
    'export function wrap(cause: unknown): Error { return new Error("x", { cause }); }',
  ],
  ["a boolean check", "export function isReady(value: unknown): boolean { return value === 1; }"],
  [
    "a type guard",
    'export function isText(value: unknown): value is string { return value === "a"; }',
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
