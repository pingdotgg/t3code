import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../lint-fixture.mjs";

const lint = createRuleFixture("project/no-agent-debug-instrumentation");

const reported = [
  ["a local ingest URL", 'fetch("http://127.0.0.1:7871/ingest");'],
  ["a debug session header", 'const headers = { "X-Debug-Session-Id": "abc" };'],
  ["an agent log region", "// #region agent log\nconsole.log(1);\n// #endregion"],
];

const allowed = [
  ["an ordinary fetch", 'fetch("https://example.com/api");'],
  ["ordinary headers", 'const headers = { Accept: "application/json" };'],
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
