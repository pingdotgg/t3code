import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../../lint-fixture.mjs";

const lint = createRuleFixture("anti-slop/no-module-mocking");

const reported = [
  ["vi.mock", 'vi.mock("./client");'],
  ["vi.doMock", 'vi.doMock("./client", () => ({}));'],
  ["jest.mock", 'jest.mock("./client");'],
];

const allowed = [
  ["a function spy", "const spy = vi.fn();"],
  ["a spied method", 'vi.spyOn(console, "log");'],
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
